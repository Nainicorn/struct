"""
CSS-driven IFC4 generator using IfcOpenShell.
Consumes Canonical Structure Schema (CSS) v1.0 and produces valid IFC4 files.

Supports:
- Element-driven generation from css.elements[]
- Confidence-based semantic mapping (>= 0.7 → proper entity, < 0.7 → proxy)
- Graded output modes: FULL_SEMANTIC, HYBRID, PROXY_ONLY
- EXTRUSION, SWEEP, and MESH geometry methods
- CSS→IFC caching via SHA-256 hash
"""

import json
import math
import hashlib
import os
from datetime import datetime, timezone
import boto3

try:
    import ifcopenshell
    import ifcopenshell.guid
except Exception as e:
    raise RuntimeError(f"IfcOpenShell not available in runtime: {e}")

s3_client = boto3.client('s3')
DATA_BUCKET = os.environ.get('DATA_BUCKET', 'builting-data')
IFC_BUCKET = os.environ.get('IFC_BUCKET', 'builting-ifc')


# ============================================================================
# CONSTANTS & MATERIAL LIBRARY
# ============================================================================

MATERIAL_COLORS = {
    'concrete': (0.75, 0.75, 0.75),
    'brick': (0.72, 0.36, 0.22),
    'steel': (0.55, 0.60, 0.65),
    'timber': (0.65, 0.45, 0.25),
    'glass': (0.7, 0.85, 0.95),
    'concrete_floor': (0.65, 0.65, 0.65),
    'metal_roof': (0.40, 0.45, 0.50),
    'metal': (0.40, 0.45, 0.50),
    'membrane': (0.30, 0.30, 0.30),
    'tiles': (0.50, 0.50, 0.55),
    'screed': (0.58, 0.58, 0.58),
    'plasterboard': (0.9, 0.9, 0.88),
    'wood': (0.55, 0.40, 0.25),
    'door': (0.55, 0.40, 0.25),
    'window': (0.7, 0.85, 0.95),
    'space': (0.88, 0.88, 0.88),
    'blasted_rock': (0.55, 0.45, 0.35),
    'unknown': (0.7, 0.7, 0.7),
}

# CSS type → IFC entity mapping (confident, >= 0.7)
SEMANTIC_IFC_MAP = {
    'WALL': 'IfcWall',
    'SLAB': 'IfcSlab',
    'COLUMN': 'IfcColumn',
    'BEAM': 'IfcBeam',
    'DOOR': 'IfcDoor',
    'WINDOW': 'IfcWindow',
    'SPACE': 'IfcSpace',
    'EQUIPMENT': 'IfcBuildingElementProxy',
    'TUNNEL_SEGMENT': 'IfcBuildingElementProxy',
    'DUCT': 'IfcBuildingElementProxy',
    'OPENING': 'IfcOpeningElement',
    'PROXY': 'IfcBuildingElementProxy',
}

# Equipment semanticType → IFC entity (when confident)
EQUIPMENT_SEMANTIC_MAP = {
    'IfcElectricGenerator': 'IfcElectricGenerator',
    'IfcPump': 'IfcPump',
    'IfcFan': 'IfcFan',
    'IfcCompressor': 'IfcCompressor',
    'IfcTransformer': 'IfcTransformer',
    'IfcBoiler': 'IfcBoiler',
    'IfcChiller': 'IfcChiller',
    'IfcAirToAirHeatRecovery': 'IfcUnitaryEquipment',
}


# ============================================================================
# HELPERS
# ============================================================================

def new_guid():
    return ifcopenshell.guid.new()


# In-memory tracking of sanitized vectors (keyed by element_id)
# Validator uses this to classify "sanitized upstream" vs "still invalid"
_sanitized_elements = {}


def normalize_vector(x, y, z, fallback=(0, 0, 1), elem_id=None, context=None):
    """Normalize a 3D vector. Returns fallback if degenerate (zero-length, NaN, inf).
    Logs with elem_id and context when fallback is used."""
    x, y, z = float(x), float(y), float(z)
    if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
        if elem_id:
            print(f"Warning: non-finite vector ({x},{y},{z}) for {context or 'vector'} "
                  f"on element {elem_id}, using fallback {fallback}")
        return fallback
    length = math.sqrt(x * x + y * y + z * z)
    if length < 1e-10:
        if elem_id:
            print(f"Warning: zero-length vector ({x},{y},{z}) for {context or 'vector'} "
                  f"on element {elem_id}, using fallback {fallback}")
        return fallback
    return (x / length, y / length, z / length)


def sanitize_axis_ref(axis_data, ref_data, elem_id=None):
    """Sanitize axis and refDirection to be unit-length, orthogonal, right-handed.
    Returns (axis_tuple, ref_tuple) as normalized 3-tuples.
    Tracks sanitization in _sanitized_elements when fixes are applied."""
    was_fixed = False

    ax = normalize_vector(
        axis_data.get('x', 0), axis_data.get('y', 0), axis_data.get('z', 1),
        fallback=(0, 0, 1), elem_id=elem_id, context='axis'
    )
    rf = normalize_vector(
        ref_data.get('x', 1), ref_data.get('y', 0), ref_data.get('z', 0),
        fallback=(1, 0, 0), elem_id=elem_id, context='refDirection'
    )

    # Check original values to detect if normalize_vector used fallback
    orig_ax_len = math.sqrt(
        float(axis_data.get('x', 0))**2 + float(axis_data.get('y', 0))**2 +
        float(axis_data.get('z', 1))**2
    ) if all(math.isfinite(float(axis_data.get(k, d))) for k, d in [('x', 0), ('y', 0), ('z', 1)]) else 0
    orig_rf_len = math.sqrt(
        float(ref_data.get('x', 1))**2 + float(ref_data.get('y', 0))**2 +
        float(ref_data.get('z', 0))**2
    ) if all(math.isfinite(float(ref_data.get(k, d))) for k, d in [('x', 1), ('y', 0), ('z', 0)]) else 0

    if orig_ax_len < 1e-10 or orig_rf_len < 1e-10:
        was_fixed = True

    # Check if ref is nearly parallel to axis
    dot = ax[0] * rf[0] + ax[1] * rf[1] + ax[2] * rf[2]
    if abs(dot) > 0.999:
        was_fixed = True
        if elem_id:
            print(f"Warning: axis and refDirection nearly parallel (dot={dot:.4f}) "
                  f"on element {elem_id}, choosing perpendicular")
        # Choose a stable perpendicular
        if abs(ax[0]) < 0.9:
            rf = (1, 0, 0)
        else:
            rf = (0, 1, 0)
        dot = ax[0] * rf[0] + ax[1] * rf[1] + ax[2] * rf[2]

    # Gram-Schmidt: remove axis component from ref
    rf = (rf[0] - dot * ax[0], rf[1] - dot * ax[1], rf[2] - dot * ax[2])
    rf = normalize_vector(rf[0], rf[1], rf[2], fallback=(1, 0, 0))

    # Verify right-handed: cross(axis, ref) should be non-degenerate
    cross = (
        ax[1] * rf[2] - ax[2] * rf[1],
        ax[2] * rf[0] - ax[0] * rf[2],
        ax[0] * rf[1] - ax[1] * rf[0]
    )
    cross_len = math.sqrt(cross[0]**2 + cross[1]**2 + cross[2]**2)
    if cross_len < 1e-10:
        was_fixed = True
        ax = (0, 0, 1)
        rf = (1, 0, 0)

    if was_fixed and elem_id:
        _sanitized_elements[elem_id] = {
            'original_axis': {k: axis_data.get(k, d) for k, d in [('x', 0), ('y', 0), ('z', 1)]},
            'original_ref': {k: ref_data.get(k, d) for k, d in [('x', 1), ('y', 0), ('z', 0)]},
            'fixed_axis': ax,
            'fixed_ref': rf,
        }

    return ax, rf


def apply_style(f, solid, color_rgb, transparency=0.0, entity_name=None):
    r, g, b = color_rgb
    color = f.create_entity('IfcColourRgb', Red=r, Green=g, Blue=b)
    rendering = f.create_entity(
        'IfcSurfaceStyleRendering',
        SurfaceColour=color,
        Transparency=transparency,
        ReflectanceMethod='FLAT'
    )
    surface_style = f.create_entity(
        'IfcSurfaceStyle',
        Name=entity_name,
        Side='BOTH',
        Styles=(rendering,)
    )
    f.create_entity('IfcStyledItem', Item=solid, Styles=(surface_style,))


def add_property_set(f, owner, element, pset_name, properties_dict):
    props = []
    for prop_name, (prop_value, ifc_type) in properties_dict.items():
        if ifc_type == 'IfcBoolean':
            nominal = f.create_entity('IfcBoolean', wrappedValue=prop_value)
        elif ifc_type == 'IfcReal':
            nominal = f.create_entity('IfcReal', wrappedValue=float(prop_value))
        elif ifc_type == 'IfcInteger':
            nominal = f.create_entity('IfcInteger', wrappedValue=int(prop_value))
        else:
            nominal = f.create_entity('IfcLabel', wrappedValue=str(prop_value))
        props.append(f.create_entity('IfcPropertySingleValue', Name=prop_name, NominalValue=nominal))

    pset = f.create_entity('IfcPropertySet', GlobalId=new_guid(), OwnerHistory=owner, Name=pset_name, HasProperties=tuple(props))
    f.create_entity('IfcRelDefinesByProperties', GlobalId=new_guid(), OwnerHistory=owner, RelatedObjects=(element,), RelatingPropertyDefinition=pset)


def add_quantity_set(f, owner, element, qset_name, quantities_dict):
    quants = []
    for quant_name, (quant_value, quant_type) in quantities_dict.items():
        if quant_type == 'IfcQuantityLength':
            quants.append(f.create_entity('IfcQuantityLength', Name=quant_name, LengthValue=float(quant_value)))
        elif quant_type == 'IfcQuantityArea':
            quants.append(f.create_entity('IfcQuantityArea', Name=quant_name, AreaValue=float(quant_value)))
        elif quant_type == 'IfcQuantityVolume':
            quants.append(f.create_entity('IfcQuantityVolume', Name=quant_name, VolumeValue=float(quant_value)))
    if quants:
        qset = f.create_entity('IfcElementQuantity', GlobalId=new_guid(), OwnerHistory=owner, Name=qset_name, Quantities=tuple(quants))
        f.create_entity('IfcRelDefinesByProperties', GlobalId=new_guid(), OwnerHistory=owner, RelatedObjects=(element,), RelatingPropertyDefinition=qset)


# ============================================================================
# GEOMETRY CREATORS
# ============================================================================

def create_extrusion(f, subcontext, profile_def, direction, depth, elem_id=None):
    """Create IfcExtrudedAreaSolid from profile, direction, and depth."""
    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    solid_pos = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)

    dir_x = direction.get('x', 0)
    dir_y = direction.get('y', 0)
    dir_z = direction.get('z', 1)
    dir_tuple = normalize_vector(dir_x, dir_y, dir_z, fallback=(0, 0, 1),
                                 elem_id=elem_id, context='extrusion direction')
    extrude_dir = f.create_entity('IfcDirection', DirectionRatios=dir_tuple)

    solid = f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile_def,
        Position=solid_pos,
        ExtrudedDirection=extrude_dir,
        Depth=float(depth)
    )

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='SweptSolid',
        Items=(solid,)
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    return solid, pds


def create_profile(f, profile_data):
    """Create IFC profile definition from CSS profile."""
    profile_type = profile_data.get('type', 'RECTANGLE')
    prof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
    prof_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
    prof_place = f.create_entity('IfcAxis2Placement2D', Location=prof_origin, RefDirection=prof_x)

    if profile_type == 'CIRCLE':
        radius = float(profile_data.get('radius', 0.5))
        return f.create_entity('IfcCircleProfileDef', ProfileType='AREA', Radius=radius, Position=prof_place)
    elif profile_type == 'ARBITRARY':
        points = profile_data.get('points', [])
        if len(points) < 3:
            return f.create_entity('IfcRectangleProfileDef', ProfileType='AREA', XDim=1.0, YDim=1.0, Position=prof_place)
        ifc_points = [f.create_entity('IfcCartesianPoint', Coordinates=(float(p['x']), float(p['y']))) for p in points]
        ifc_points.append(ifc_points[0])  # close the loop
        polyline = f.create_entity('IfcPolyline', Points=tuple(ifc_points))
        return f.create_entity('IfcArbitraryClosedProfileDef', ProfileType='AREA', OuterCurve=polyline)
    else:  # RECTANGLE
        w = float(profile_data.get('width', 1.0))
        h = float(profile_data.get('height', 1.0))
        return f.create_entity('IfcRectangleProfileDef', ProfileType='AREA', XDim=w, YDim=h, Position=prof_place)


def create_mesh_geometry(f, subcontext, vertices, faces):
    """Create IfcFaceBasedSurfaceModel from vertices and face indices."""
    ifc_verts = [f.create_entity('IfcCartesianPoint', Coordinates=(float(v['x']), float(v['y']), float(v['z']))) for v in vertices]

    ifc_faces = []
    for face_indices in faces:
        if len(face_indices) < 3:
            continue
        face_points = [ifc_verts[i] for i in face_indices if i < len(ifc_verts)]
        if len(face_points) < 3:
            continue
        poly = f.create_entity('IfcPolyLoop', Polygon=tuple(face_points))
        bound = f.create_entity('IfcFaceOuterBound', Bound=poly, Orientation=True)
        ifc_faces.append(f.create_entity('IfcFace', Bounds=(bound,)))

    if not ifc_faces:
        return None, None

    face_set = f.create_entity('IfcConnectedFaceSet', CfsFaces=tuple(ifc_faces))
    surface_model = f.create_entity('IfcFaceBasedSurfaceModel', FbsmFaces=(face_set,))

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='SurfaceModel',
        Items=(surface_model,)
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    return surface_model, pds


def create_element_geometry(f, subcontext, geometry, elem_id=None):
    """Create IFC geometry from CSS geometry definition. Returns (solid_or_surface, pds, fallback_used).
    Implements escalation chain: extrusion → sanitized extrusion → mesh fallback → None."""
    method = geometry.get('method', 'EXTRUSION')
    fallback_used = None

    if method == 'MESH':
        vertices = geometry.get('vertices', [])
        faces = geometry.get('faces', [])
        if not vertices or not faces:
            return None, None, 'proxy_no_geometry'
        result = create_mesh_geometry(f, subcontext, vertices, faces)
        return result[0], result[1], None

    # EXTRUSION or SWEEP — both use profile + direction + depth
    profile_data = geometry.get('profile', {'type': 'RECTANGLE', 'width': 1, 'height': 1})
    direction = geometry.get('direction', {'x': 0, 'y': 0, 'z': 1})
    depth = geometry.get('depth', 1.0)

    if depth <= 0:
        depth = 0.01  # clamp to minimum

    # Attempt 1: Normal extrusion
    try:
        profile_def = create_profile(f, profile_data)
        solid, pds = create_extrusion(f, subcontext, profile_def, direction, depth, elem_id=elem_id)
        return solid, pds, None
    except Exception as e1:
        if elem_id:
            print(f"Warning: Extrusion failed for {elem_id}: {e1}, trying sanitized params")

    # Attempt 2: Sanitized extrusion
    try:
        sanitized_depth = max(depth, 1e-4)
        sanitized_profile = dict(profile_data)
        if sanitized_profile.get('width') is not None:
            sanitized_profile['width'] = max(float(sanitized_profile.get('width', 1)), 1e-4)
        if sanitized_profile.get('height') is not None:
            sanitized_profile['height'] = max(float(sanitized_profile.get('height', 1)), 1e-4)
        if sanitized_profile.get('radius') is not None:
            sanitized_profile['radius'] = max(float(sanitized_profile.get('radius', 0.5)), 1e-4)

        profile_def = create_profile(f, sanitized_profile)
        solid, pds = create_extrusion(f, subcontext, profile_def, direction, sanitized_depth, elem_id=elem_id)
        fallback_used = 'sanitized_extrusion'
        return solid, pds, fallback_used
    except Exception as e2:
        if elem_id:
            print(f"Warning: Sanitized extrusion failed for {elem_id}: {e2}, trying mesh fallback")

    # Attempt 3: Mesh fallback — create bounding box as IfcTriangulatedFaceSet
    try:
        w = max(float(profile_data.get('width', profile_data.get('radius', 1))), 0.01)
        h = max(float(profile_data.get('height', profile_data.get('radius', 1))), 0.01)
        d = max(float(depth), 0.01)
        hw, hh = w / 2.0, h / 2.0

        # 8 vertices of a box centered at origin
        coords = [
            (-hw, -hh, 0.0), (hw, -hh, 0.0), (hw, hh, 0.0), (-hw, hh, 0.0),
            (-hw, -hh, d),   (hw, -hh, d),   (hw, hh, d),   (-hw, hh, d),
        ]
        coord_list = f.create_entity('IfcCartesianPointList3D', CoordList=coords)

        # 12 triangles (2 per face)
        indices = [
            (1,2,3), (1,3,4),  # bottom
            (5,7,6), (5,8,7),  # top
            (1,5,6), (1,6,2),  # front
            (3,7,8), (3,8,4),  # back
            (1,4,8), (1,8,5),  # left
            (2,6,7), (2,7,3),  # right
        ]
        tri_face_set = f.create_entity(
            'IfcTriangulatedFaceSet',
            Coordinates=coord_list,
            CoordIndex=indices
        )

        body_rep = f.create_entity(
            'IfcShapeRepresentation',
            ContextOfItems=subcontext,
            RepresentationIdentifier='Body',
            RepresentationType='Tessellation',
            Items=(tri_face_set,)
        )
        pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
        fallback_used = 'mesh'
        if elem_id:
            print(f"Mesh fallback used for {elem_id}")
        return tri_face_set, pds, fallback_used
    except Exception as e3:
        if elem_id:
            print(f"Warning: All geometry attempts failed for {elem_id}: {e3}")
        return None, None, 'proxy_no_geometry'


# ============================================================================
# PLACEMENT
# ============================================================================

def create_element_placement(f, parent_lp, placement, elem_id=None):
    """Create IfcLocalPlacement from CSS placement with sanitized axis/refDirection."""
    origin = placement.get('origin', {'x': 0, 'y': 0, 'z': 0})
    axis_data = placement.get('axis', {'x': 0, 'y': 0, 'z': 1})
    ref_data = placement.get('refDirection', {'x': 1, 'y': 0, 'z': 0})

    pt = f.create_entity('IfcCartesianPoint', Coordinates=(
        float(origin.get('x', 0)), float(origin.get('y', 0)), float(origin.get('z', 0))
    ))

    ax_tuple, rf_tuple = sanitize_axis_ref(axis_data, ref_data, elem_id=elem_id)
    axis = f.create_entity('IfcDirection', DirectionRatios=ax_tuple)
    refd = f.create_entity('IfcDirection', DirectionRatios=rf_tuple)

    place = f.create_entity('IfcAxis2Placement3D', Location=pt, Axis=axis, RefDirection=refd)
    return f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=place)


# ============================================================================
# IFC ENTITY RESOLUTION
# ============================================================================

def resolve_ifc_entity_type(elem, output_mode):
    """Determine the IFC entity type to use for a CSS element."""
    css_type = elem.get('type', 'PROXY')
    semantic_type = elem.get('semanticType', '')
    confidence = float(elem.get('confidence', 0.5))

    # PROXY_ONLY mode — everything is proxy
    if output_mode == 'PROXY_ONLY':
        return 'IfcBuildingElementProxy'

    # IfcSpace always stays IfcSpace
    if css_type == 'SPACE':
        return 'IfcSpace'

    # Low confidence in HYBRID mode → proxy
    if output_mode == 'HYBRID' and confidence < 0.7:
        return 'IfcBuildingElementProxy'

    # FULL_SEMANTIC or high-confidence HYBRID
    if css_type == 'PROXY':
        return 'IfcBuildingElementProxy'

    # Check equipment-specific semantic types
    if css_type == 'EQUIPMENT' and semantic_type in EQUIPMENT_SEMANTIC_MAP:
        try:
            # Verify the entity exists in IfcOpenShell
            entity_name = EQUIPMENT_SEMANTIC_MAP[semantic_type]
            return entity_name
        except Exception:
            return 'IfcBuildingElementProxy'

    # Use the standard mapping
    return SEMANTIC_IFC_MAP.get(css_type, 'IfcBuildingElementProxy')


def get_predefined_type(ifc_entity_type, css_type):
    """Return appropriate PredefinedType for the IFC entity."""
    mapping = {
        'IfcWall': 'SOLIDWALL',
        'IfcSlab': 'FLOOR',
        'IfcColumn': 'COLUMN',
        'IfcBeam': 'BEAM',
        'IfcDoor': 'DOOR',
        'IfcWindow': 'WINDOW',
    }
    return mapping.get(ifc_entity_type)


# ============================================================================
# CSS-DRIVEN IFC GENERATOR
# ============================================================================

def generate_ifc4_from_css(css):
    """Generate IFC4 from CSS v1.0 format. Element-driven, confidence-based."""

    facility = css.get('facility', {})
    levels = css.get('levelsOrSegments', [])
    elements = css.get('elements', [])
    metadata = css.get('metadata', {})
    output_mode = metadata.get('outputMode', 'HYBRID')

    placement_z_is_absolute = metadata.get('placementZIsAbsolute', True)

    facility_name = facility.get('name', 'Structure')
    ts = int(datetime.now(timezone.utc).timestamp())

    # Clear sanitization tracking for this generation run
    _sanitized_elements.clear()

    # ---- Create IFC file ----
    f = ifcopenshell.file(schema='IFC4')

    # Owner History
    person = f.create_entity('IfcPerson', GivenName='Person')
    org = f.create_entity('IfcOrganization', Name='Builting')
    pando = f.create_entity('IfcPersonAndOrganization', ThePerson=person, TheOrganization=org)
    app = f.create_entity('IfcApplication', ApplicationDeveloper=org, Version='2.0', ApplicationFullName='Builting CSS-to-IFC', ApplicationIdentifier='BCSS')
    owner = f.create_entity('IfcOwnerHistory', OwningUser=pando, OwningApplication=app, ChangeAction='ADDED', CreationDate=ts)

    # Units
    u_len = f.create_entity('IfcSIUnit', UnitType='LENGTHUNIT', Name='METRE')
    u_area = f.create_entity('IfcSIUnit', UnitType='AREAUNIT', Name='SQUARE_METRE')
    u_vol = f.create_entity('IfcSIUnit', UnitType='VOLUMEUNIT', Name='CUBIC_METRE')
    u_ang = f.create_entity('IfcSIUnit', UnitType='PLANEANGLEUNIT', Name='RADIAN')
    units = f.create_entity('IfcUnitAssignment', Units=(u_len, u_area, u_vol, u_ang))

    # Geometry context
    wcs_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    wcs_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    wcs_refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    wcs = f.create_entity('IfcAxis2Placement3D', Location=wcs_origin, Axis=wcs_axis, RefDirection=wcs_refd)

    context = f.create_entity('IfcGeometricRepresentationContext', ContextIdentifier='Model', ContextType='Model', CoordinateSpaceDimension=3, Precision=1e-5, WorldCoordinateSystem=wcs)
    subcontext = f.create_entity('IfcGeometricRepresentationSubContext', ContextIdentifier='Body', ContextType='Model', ParentContext=context, TargetView='MODEL_VIEW')

    # ---- Spatial hierarchy: Project → Site → Building → Storeys ----
    project = f.create_entity('IfcProject', GlobalId=new_guid(), OwnerHistory=owner, Name=facility_name, RepresentationContexts=(context,), UnitsInContext=units)
    proj_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=None, RelativePlacement=wcs)

    site = f.create_entity('IfcSite', GlobalId=new_guid(), OwnerHistory=owner, Name='Site', ObjectPlacement=proj_lp, CompositionType='ELEMENT')

    # Building placement relative to Site (not Project) for consistent chain
    bld_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=site.ObjectPlacement, RelativePlacement=wcs)
    building = f.create_entity('IfcBuilding', GlobalId=new_guid(), OwnerHistory=owner, Name=facility_name, ObjectPlacement=bld_lp, CompositionType='ELEMENT')

    f.create_entity('IfcRelAggregates', GlobalId=new_guid(), OwnerHistory=owner, RelatingObject=project, RelatedObjects=(site,))
    f.create_entity('IfcRelAggregates', GlobalId=new_guid(), OwnerHistory=owner, RelatingObject=site, RelatedObjects=(building,))

    # Create storeys/segments from levelsOrSegments
    storey_map = {}  # container_id → (storey_entity, storey_lp, elevation)
    storey_entities = []
    prev_elevation = None
    prev_height = None

    for i, level in enumerate(levels):
        level_id = level.get('id', f'level-{i + 1}')
        level_name = level.get('name', 'Level')
        level_type = level.get('type', 'STOREY')
        height_m = level.get('height_m')

        # Compute elevation: use explicit value, or derive cumulatively
        explicit_elevation = level.get('elevation_m')
        if explicit_elevation is not None:
            elevation = float(explicit_elevation)
        elif prev_elevation is not None and prev_height is not None:
            elevation = prev_elevation + prev_height
        else:
            elevation = 0.0

        # Validate monotonically increasing
        if prev_elevation is not None and elevation < prev_elevation:
            print(f"Warning: storey '{level_name}' elevation {elevation}m < previous {prev_elevation}m")

        # Warn if delta between storeys differs from expected height_m by > 0.25m
        if prev_elevation is not None and prev_height is not None:
            delta = elevation - prev_elevation
            if abs(delta - prev_height) > 0.25:
                print(f"Warning: storey '{level_name}' delta {delta:.2f}m differs from "
                      f"prev height_m {prev_height:.2f}m by {abs(delta - prev_height):.2f}m")

        # Track for next iteration — always set prev_height from current height_m
        if height_m is not None:
            prev_height = float(height_m)
        else:
            if level_type == 'STOREY':
                print(f"Warning: storey '{level_name}' missing height_m, "
                      f"cannot compute next storey elevation cumulatively")
            prev_height = None
        prev_elevation = elevation

        lvl_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, elevation))
        lvl_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
        lvl_refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
        lvl_place = f.create_entity('IfcAxis2Placement3D', Location=lvl_origin, Axis=lvl_axis, RefDirection=lvl_refd)
        lvl_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=bld_lp, RelativePlacement=lvl_place)

        storey = f.create_entity(
            'IfcBuildingStorey',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=level_name,
            ObjectPlacement=lvl_lp,
            CompositionType='ELEMENT',
            Elevation=elevation
        )

        # Write height_m as custom Pset on storey for debugging
        if height_m is not None:
            add_property_set(f, owner, storey, 'Pset_StoreyHeight', {
                'StoreyHeight': (float(height_m), 'IfcReal'),
            })

        storey_map[level_id] = (storey, lvl_lp, elevation)
        storey_entities.append(storey)

    # If no levels created, add a default
    if not storey_entities:
        default_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=bld_lp, RelativePlacement=wcs)
        default_storey = f.create_entity('IfcBuildingStorey', GlobalId=new_guid(), OwnerHistory=owner, Name='Ground Floor', ObjectPlacement=default_lp, CompositionType='ELEMENT', Elevation=0.0)
        storey_map['level-1'] = (default_storey, default_lp, 0.0)
        storey_entities.append(default_storey)

    f.create_entity('IfcRelAggregates', GlobalId=new_guid(), OwnerHistory=owner, RelatingObject=building, RelatedObjects=tuple(storey_entities))

    # ---- Process elements ----
    # Group elements by container for IfcRelContainedInSpatialStructure
    elements_by_container = {}
    ifc_elements_by_css_id = {}  # css_id → ifc_element (for relationships)
    element_count = 0
    error_count = 0
    # Track original z values per container for heuristic warning
    original_z_by_container = {}  # container_id → [z_values]

    for elem in elements:
        try:
            css_id = elem.get('id', f'elem-{element_count}')
            css_type = elem.get('type', 'PROXY')
            elem_name = elem.get('name', css_type)
            container_id = elem.get('container', 'level-1')
            placement_data = elem.get('placement', {'origin': {'x': 0, 'y': 0, 'z': 0}})
            geometry_data = elem.get('geometry', {'method': 'EXTRUSION', 'profile': {'type': 'RECTANGLE', 'width': 1, 'height': 1}, 'depth': 1})
            material_data = elem.get('material')
            confidence = float(elem.get('confidence', 0.5))
            properties = elem.get('properties', {})

            # Resolve container
            if container_id not in storey_map:
                # Fallback to first available storey
                container_id = list(storey_map.keys())[0]
            storey_entity, storey_lp, storey_elevation = storey_map[container_id]

            # Adjust element z — conditional on placementZIsAbsolute
            placement_origin = placement_data.get('origin', {'x': 0, 'y': 0, 'z': 0})
            original_z = float(placement_origin.get('z', 0))

            # Track original z for heuristic
            if container_id not in original_z_by_container:
                original_z_by_container[container_id] = []
            original_z_by_container[container_id].append(original_z)

            if placement_z_is_absolute:
                relative_z = original_z - storey_elevation
            else:
                relative_z = original_z  # already storey-relative

            placement_data = dict(placement_data)
            placement_data['origin'] = {**placement_origin, 'z': relative_z}

            # Create placement (with sanitized axis/ref)
            elem_lp = create_element_placement(f, storey_lp, placement_data, elem_id=css_id)

            # Create geometry (with normalized direction + fallback chain)
            solid_or_surface, pds, fallback_used = create_element_geometry(f, subcontext, geometry_data, elem_id=css_id)
            if solid_or_surface is None or pds is None:
                print(f"Warning: Failed to create geometry for {css_id}, skipping")
                error_count += 1
                continue
            if fallback_used:
                if 'geometryFallbacks' not in metadata:
                    metadata['geometryFallbacks'] = {}
                metadata['geometryFallbacks'][css_id] = fallback_used

            # Apply material/color
            if material_data:
                mat_name = material_data.get('name', 'unknown')
                mat_color = material_data.get('color')
                if mat_color and len(mat_color) == 3:
                    color_rgb = tuple(mat_color)
                else:
                    color_rgb = MATERIAL_COLORS.get(mat_name, (0.7, 0.7, 0.7))
                transparency = float(material_data.get('transparency', 0))
            else:
                color_rgb = MATERIAL_COLORS.get('unknown', (0.7, 0.7, 0.7))
                transparency = 0.0

            apply_style(f, solid_or_surface, color_rgb, transparency=transparency, entity_name=elem_name)

            # Resolve IFC entity type
            ifc_entity_type = resolve_ifc_entity_type(elem, output_mode)

            # Create IFC element
            create_kwargs = {
                'GlobalId': new_guid(),
                'OwnerHistory': owner,
                'Name': elem_name,
                'ObjectPlacement': elem_lp,
                'Representation': pds,
            }

            # Add PredefinedType where appropriate
            predef = get_predefined_type(ifc_entity_type, css_type)
            if predef:
                create_kwargs['PredefinedType'] = predef

            # IfcDoor/IfcWindow need OverallHeight/OverallWidth
            if ifc_entity_type == 'IfcDoor':
                profile = geometry_data.get('profile', {})
                create_kwargs['OverallWidth'] = float(profile.get('width', 0.9))
                create_kwargs['OverallHeight'] = float(geometry_data.get('depth', 2.1))
            elif ifc_entity_type == 'IfcWindow':
                profile = geometry_data.get('profile', {})
                create_kwargs['OverallWidth'] = float(profile.get('width', 1.2))
                create_kwargs['OverallHeight'] = float(geometry_data.get('depth', 1.2))

            # IfcSpace needs ObjectType
            if ifc_entity_type == 'IfcSpace':
                create_kwargs['ObjectType'] = properties.get('usage', 'OTHER')

            # IfcSlab PredefinedType from properties
            if ifc_entity_type == 'IfcSlab' and properties.get('slabType'):
                create_kwargs['PredefinedType'] = properties['slabType']

            # IfcBuildingElementProxy gets ObjectType from css_type
            if ifc_entity_type == 'IfcBuildingElementProxy':
                create_kwargs['ObjectType'] = css_type

            try:
                ifc_element = f.create_entity(ifc_entity_type, **create_kwargs)
            except Exception as entity_err:
                # Fallback to proxy if entity creation fails
                print(f"Warning: Failed to create {ifc_entity_type} for {css_id}: {entity_err}, falling back to proxy")
                create_kwargs.pop('PredefinedType', None)
                create_kwargs.pop('OverallHeight', None)
                create_kwargs.pop('OverallWidth', None)
                create_kwargs.pop('ObjectType', None)
                create_kwargs['ObjectType'] = css_type
                ifc_element = f.create_entity('IfcBuildingElementProxy', **create_kwargs)

            ifc_elements_by_css_id[css_id] = ifc_element

            # Add Pset_ProxyMetadata for proxies
            if ifc_entity_type == 'IfcBuildingElementProxy':
                semantic_type = elem.get('semanticType', '')
                source = elem.get('source', 'LLM')
                add_property_set(f, owner, ifc_element, 'Pset_ProxyMetadata', {
                    'OriginalType': (css_type, 'IfcLabel'),
                    'SemanticType': (semantic_type, 'IfcLabel'),
                    'Source': (source, 'IfcLabel'),
                    'Confidence': (confidence, 'IfcReal'),
                })

            # Add element-specific property sets
            if css_type == 'WALL':
                is_external = properties.get('isExternal', True)
                add_property_set(f, owner, ifc_element, 'Pset_WallCommon', {
                    'IsExternal': (is_external, 'IfcBoolean'),
                    'LoadBearing': (True, 'IfcBoolean'),
                })
            elif css_type == 'SLAB':
                add_property_set(f, owner, ifc_element, 'Pset_SlabCommon', {
                    'IsExternal': (properties.get('slabType') == 'ROOF', 'IfcBoolean'),
                    'LoadBearing': (True, 'IfcBoolean'),
                })
            elif css_type == 'SPACE':
                profile = geometry_data.get('profile', {})
                w = float(profile.get('width', 1))
                h = float(profile.get('height', 1))
                add_property_set(f, owner, ifc_element, 'Pset_SpaceCommon', {
                    'IsExternal': (False, 'IfcBoolean'),
                    'NetFloorArea': (w * h, 'IfcReal'),
                })

            # Add custom CSS properties as a property set
            if properties:
                css_props = {}
                for k, v in properties.items():
                    if isinstance(v, bool):
                        css_props[k] = (v, 'IfcBoolean')
                    elif isinstance(v, (int, float)):
                        css_props[k] = (v, 'IfcReal')
                    elif isinstance(v, str):
                        css_props[k] = (v, 'IfcLabel')
                if css_props:
                    add_property_set(f, owner, ifc_element, 'Pset_CSSProperties', css_props)

            # Group by container
            if container_id not in elements_by_container:
                elements_by_container[container_id] = []
            elements_by_container[container_id].append(ifc_element)

            element_count += 1

        except Exception as e:
            print(f"Error creating element {elem.get('id', '?')}: {e}")
            error_count += 1

    # ---- Heuristic: detect possible double-subtraction ----
    if placement_z_is_absolute:
        for cid, z_vals in original_z_by_container.items():
            if cid in storey_map and len(z_vals) >= 2:
                _, _, s_elev = storey_map[cid]
                if s_elev > 1.0:
                    sorted_z = sorted(z_vals)
                    median_z = sorted_z[len(sorted_z) // 2]
                    if abs(median_z) < 0.5:
                        s_name = storey_map[cid][0].Name or cid
                        print(f"Warning: elements in storey '{s_name}' (elev={s_elev}m) have "
                              f"median z={median_z:.2f}m — may already be storey-relative. "
                              f"Check metadata.placementZIsAbsolute flag.")

    # ---- Process VOIDS relationships (v3.2: IfcOpeningElement intermediary) ----
    opening_elements_for_storey = {}  # container_id -> list of IfcOpeningElement
    for elem in elements:
        relationships = elem.get('relationships', [])
        css_id = elem.get('id', '')
        container_id = elem.get('container', '')

        for rel in relationships:
            rel_type = rel.get('type', '')
            target_id = rel.get('target', '')

            if rel_type == 'VOIDS' and css_id in ifc_elements_by_css_id and target_id in ifc_elements_by_css_id:
                door_or_window = ifc_elements_by_css_id[css_id]
                host_wall = ifc_elements_by_css_id[target_id]

                try:
                    ifc_type = door_or_window.is_a()

                    if ifc_type in ('IfcDoor', 'IfcWindow'):
                        # IFC spec requires: Wall → IfcOpeningElement → IfcDoor/IfcWindow
                        # Create an IfcOpeningElement with same placement and geometry
                        opening_element = f.create_entity(
                            'IfcOpeningElement',
                            GlobalId=new_guid(),
                            OwnerHistory=owner,
                            Name=f"Opening_{css_id}",
                            ObjectPlacement=door_or_window.ObjectPlacement,
                            Representation=door_or_window.Representation,
                        )

                        # Wall → IfcOpeningElement (VOIDS)
                        f.create_entity('IfcRelVoidsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingBuildingElement=host_wall,
                                        RelatedOpeningElement=opening_element)

                        # IfcOpeningElement → IfcDoor/IfcWindow (FILLS)
                        f.create_entity('IfcRelFillsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingOpeningElement=opening_element,
                                        RelatedBuildingElement=door_or_window)

                        # Track opening element for storey containment
                        if container_id not in opening_elements_for_storey:
                            opening_elements_for_storey[container_id] = []
                        opening_elements_for_storey[container_id].append(opening_element)

                    elif ifc_type == 'IfcOpeningElement':
                        # Already an IfcOpeningElement — use directly
                        f.create_entity('IfcRelVoidsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingBuildingElement=host_wall,
                                        RelatedOpeningElement=door_or_window)
                    else:
                        # Fallback: skip — cannot create VOIDS for non-door/window/opening types
                        print(f"Warning: VOIDS skipped for {css_id} ({ifc_type}) — not a door/window/opening")

                except Exception as e:
                    print(f"Warning: Could not create VOIDS relationship {css_id} → {target_id}: {e}")

            elif rel_type == 'FILLS' and css_id in ifc_elements_by_css_id and target_id in ifc_elements_by_css_id:
                fill_elem = ifc_elements_by_css_id[css_id]
                opening_elem = ifc_elements_by_css_id[target_id]
                try:
                    f.create_entity('IfcRelFillsElement', GlobalId=new_guid(), OwnerHistory=owner,
                                    RelatingOpeningElement=opening_elem, RelatedBuildingElement=fill_elem)
                except Exception as e:
                    print(f"Warning: Could not create FILLS relationship {css_id} → {target_id}: {e}")

    # ---- Relate elements to storeys ----
    for container_id, ifc_elems in elements_by_container.items():
        if container_id in storey_map and ifc_elems:
            # Include any IfcOpeningElements created for this storey
            all_elems = list(ifc_elems)
            if container_id in opening_elements_for_storey:
                all_elems.extend(opening_elements_for_storey[container_id])
            storey_entity, _, _elev = storey_map[container_id]
            f.create_entity(
                'IfcRelContainedInSpatialStructure',
                GlobalId=new_guid(),
                OwnerHistory=owner,
                RelatedElements=tuple(all_elems),
                RelatingStructure=storey_entity
            )

    print(f"IFC generation complete: {element_count} elements created, {error_count} errors, mode={output_mode}")

    return f.to_string(), element_count, error_count


# ============================================================================
# CSS HASH + CACHING
# ============================================================================

def compute_css_hash(css):
    """Compute SHA-256 hash of CSS for caching."""
    css_str = json.dumps(css, sort_keys=True)
    return hashlib.sha256(css_str.encode('utf-8')).hexdigest()


def check_cache(css_hash):
    """Check if a cached IFC exists for this CSS hash."""
    cache_key = f'cache/{css_hash}/model.ifc'
    try:
        response = s3_client.get_object(Bucket=IFC_BUCKET, Key=cache_key)
        ifc_content = response['Body'].read().decode('utf-8')
        print(f"Cache HIT for hash {css_hash[:12]}...")
        return ifc_content
    except Exception:
        return None


def store_cache(css_hash, ifc_content):
    """Store generated IFC in cache."""
    cache_key = f'cache/{css_hash}/model.ifc'
    try:
        s3_client.put_object(Bucket=IFC_BUCKET, Key=cache_key, Body=ifc_content.encode('utf-8'), ContentType='text/plain')
        print(f"Cached IFC at {cache_key}")
    except Exception as e:
        print(f"Warning: Failed to cache IFC: {e}")


# ============================================================================
# INLINE IFC VALIDATION (replaces standalone ValidateIFC Lambda)
# ============================================================================

def _get_absolute_coords(local_placement):
    """Walk the placement chain to accumulate absolute coordinates."""
    x, y, z = 0.0, 0.0, 0.0
    lp = local_placement
    while lp is not None:
        if hasattr(lp, 'RelativePlacement') and lp.RelativePlacement:
            loc = lp.RelativePlacement.Location
            if loc and loc.Coordinates:
                coords = loc.Coordinates
                x += float(coords[0])
                y += float(coords[1])
                z += float(coords[2]) if len(coords) > 2 else 0.0
        if hasattr(lp, 'PlacementRelTo'):
            lp = lp.PlacementRelTo
        else:
            break
    return x, y, z


def _get_profile_bounds(profile_def):
    """Get half-extents (hx, hy) from a profile definition.
    Returns None if profile type is not recognized."""
    try:
        if profile_def.is_a('IfcRectangleProfileDef'):
            return (float(profile_def.XDim) / 2.0, float(profile_def.YDim) / 2.0)
        elif profile_def.is_a('IfcCircleProfileDef'):
            r = float(profile_def.Radius)
            return (r, r)
    except Exception:
        pass
    return None


def _get_geometry_extents(product):
    """Extract approximate geometry extents from product representation.
    Returns (dx, dy, dz) expansion or None."""
    try:
        if not product.Representation:
            return None
        for rep in product.Representation.Representations:
            for item in rep.Items:
                if item.is_a('IfcExtrudedAreaSolid'):
                    depth = float(item.Depth)
                    dr = item.ExtrudedDirection.DirectionRatios
                    dx, dy = 0.0, 0.0
                    dz = depth  # default: assume mostly vertical

                    # Get profile bounds for X/Y expansion
                    bounds = _get_profile_bounds(item.SweptArea)
                    if bounds:
                        dx, dy = bounds

                    # If direction is mostly Z (abs(dz_ratio) > 0.9), expand Z by depth
                    dz_ratio = float(dr[2]) if len(dr) > 2 else 1.0
                    if abs(dz_ratio) > 0.9:
                        return (dx, dy, depth)
                    else:
                        # Non-axis-aligned: conservative — expand all axes by depth
                        return (max(dx, depth), max(dy, depth), max(dz, depth))
    except Exception:
        pass
    return None


def validate_ifc(ifc_content, user_id, render_id):
    """Validate generated IFC content. Returns (valid, errors, warnings, element_summary, bbox)."""
    errors = []
    warnings = []
    element_summary = {}
    bbox = None

    try:
        # Write to temp file for IfcOpenShell
        with open('/tmp/validate.ifc', 'w') as vf:
            vf.write(ifc_content)

        try:
            ifc_file = ifcopenshell.open('/tmp/validate.ifc')
        except Exception as parse_err:
            errors.append(f"IFC parse error: {parse_err}")
            return False, errors, warnings, element_summary, bbox

        # Check spatial structure
        if not ifc_file.by_type('IfcProject'):
            errors.append("No IfcProject found")
        if not ifc_file.by_type('IfcSite'):
            warnings.append("No IfcSite found")
        if not ifc_file.by_type('IfcBuilding'):
            warnings.append("No IfcBuilding found")
        if not ifc_file.by_type('IfcBuildingStorey'):
            warnings.append("No IfcBuildingStorey found")

        # Check products — exclude spatial containers from Representation check
        products = ifc_file.by_type('IfcProduct')
        spatial_types = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey'}
        non_spatial = [p for p in products if p.is_a() not in spatial_types]

        missing_rep = sum(1 for p in non_spatial if not p.Representation)
        missing_placement = sum(1 for p in products if not p.ObjectPlacement)

        if missing_rep > 0:
            warnings.append(f"{missing_rep} non-spatial products missing Representation")
        if missing_placement > 0:
            warnings.append(f"{missing_placement} products missing ObjectPlacement")

        if not ifc_file.by_type('IfcRelContainedInSpatialStructure'):
            warnings.append("No IfcRelContainedInSpatialStructure found")

        # ---- Direction vector validation (scoped to placements + extrusions) ----
        invalid_directions = 0
        sanitized_directions = 0

        # Check IfcLocalPlacement → RelativePlacement (Axis2Placement3D)
        for lp in ifc_file.by_type('IfcLocalPlacement'):
            try:
                rp = lp.RelativePlacement
                if rp and rp.is_a('IfcAxis2Placement3D'):
                    if rp.Axis:
                        ar = rp.Axis.DirectionRatios
                        ax_len = math.sqrt(sum(float(r)**2 for r in ar))
                        if ax_len < 1e-6 or not all(math.isfinite(float(r)) for r in ar):
                            invalid_directions += 1

                    if rp.RefDirection:
                        rr = rp.RefDirection.DirectionRatios
                        rf_len = math.sqrt(sum(float(r)**2 for r in rr))
                        if rf_len < 1e-6 or not all(math.isfinite(float(r)) for r in rr):
                            invalid_directions += 1

                    # Check axis/refDirection not parallel
                    if rp.Axis and rp.RefDirection:
                        ar = rp.Axis.DirectionRatios
                        rr = rp.RefDirection.DirectionRatios
                        dot = sum(float(a) * float(r) for a, r in zip(ar, rr))
                        if abs(dot) > 0.999:
                            invalid_directions += 1
            except Exception:
                pass

        # Check IfcExtrudedAreaSolid.ExtrudedDirection
        for solid in ifc_file.by_type('IfcExtrudedAreaSolid'):
            try:
                dr = solid.ExtrudedDirection.DirectionRatios
                d_len = math.sqrt(sum(float(r)**2 for r in dr))
                if d_len < 1e-6 or not all(math.isfinite(float(r)) for r in dr):
                    invalid_directions += 1
            except Exception:
                pass

        # Classify: sanitized upstream vs still invalid
        sanitized_directions = len(_sanitized_elements)
        if invalid_directions > 0:
            errors.append(f"{invalid_directions} invalid direction vectors found in IFC")
        if sanitized_directions > 0:
            warnings.append(f"{sanitized_directions} direction vectors were sanitized during generation")

        # ---- Viewer compatibility checks (Phase 6E) ----
        compatibility_issues = []
        mesh_fallback_count = 0
        proxy_fallback_count = 0

        # Check for IfcTriangulatedFaceSet (mesh fallbacks)
        try:
            mesh_fallback_count = len(ifc_file.by_type('IfcTriangulatedFaceSet'))
        except Exception:
            pass

        # Check all IfcDirection for NaN/Inf
        for direction in ifc_file.by_type('IfcDirection'):
            try:
                for r in direction.DirectionRatios:
                    if not math.isfinite(float(r)):
                        compatibility_issues.append({
                            'severity': 'error',
                            'type': 'nan_inf_direction',
                            'detail': f'IfcDirection #{direction.id()} has non-finite value'
                        })
                        break
            except Exception:
                pass

        # Check IfcCartesianPoint for large coordinates
        for point in ifc_file.by_type('IfcCartesianPoint'):
            try:
                for c in point.Coordinates:
                    if abs(float(c)) > 1e6:
                        compatibility_issues.append({
                            'severity': 'warning',
                            'type': 'large_coordinate',
                            'detail': f'IfcCartesianPoint #{point.id()} has coordinate > 1e6'
                        })
                        break
            except Exception:
                pass

        # Check storey containment — every non-spatial element should be in a storey
        contained_elements = set()
        for rel in ifc_file.by_type('IfcRelContainedInSpatialStructure'):
            try:
                for elem in rel.RelatedElements:
                    contained_elements.add(elem.id())
            except Exception:
                pass

        orphaned = 0
        for product in non_spatial:
            if product.id() not in contained_elements:
                orphaned += 1
        if orphaned > 0:
            compatibility_issues.append({
                'severity': 'warning',
                'type': 'orphaned_elements',
                'detail': f'{orphaned} elements not contained by any storey'
            })

        # Check every non-spatial element has Body representation
        missing_body = 0
        for product in non_spatial:
            has_body = False
            if product.Representation:
                for rep in product.Representation.Representations:
                    if rep.RepresentationIdentifier == 'Body':
                        has_body = True
                        break
            if not has_body:
                missing_body += 1
        if missing_body > 0:
            compatibility_issues.append({
                'severity': 'warning',
                'type': 'missing_body_rep',
                'detail': f'{missing_body} elements missing Body representation'
            })

        # Compute compatibility score
        total_checks = len(non_spatial) * 2 + len(ifc_file.by_type('IfcDirection'))
        issue_weight = len([i for i in compatibility_issues if i['severity'] == 'error']) * 10 + \
                       len([i for i in compatibility_issues if i['severity'] == 'warning'])
        compatibility_score = max(0, min(100, 100 - int(issue_weight / max(total_checks, 1) * 100)))

        # Element count summary
        for product in products:
            entity_type = product.is_a()
            element_summary[entity_type] = element_summary.get(entity_type, 0) + 1

        # ---- Bbox check — walk parent chain + approximate geometry extents ----
        min_x = min_y = min_z = float('inf')
        max_x = max_y = max_z = float('-inf')
        bbox_mode = 'placement-only'

        for product in products:
            if product.ObjectPlacement:
                try:
                    px, py, pz = _get_absolute_coords(product.ObjectPlacement)
                    min_x, min_y, min_z = min(min_x, px), min(min_y, py), min(min_z, pz)
                    max_x, max_y, max_z = max(max_x, px), max(max_y, py), max(max_z, pz)

                    # Approximate with geometry extents
                    extents = _get_geometry_extents(product)
                    if extents is not None:
                        bbox_mode = 'approx'
                        dx, dy, dz = extents
                        # Expand in both positive directions from placement
                        min_x = min(min_x, px - dx)
                        min_y = min(min_y, py - dy)
                        max_x = max(max_x, px + dx)
                        max_y = max(max_y, py + dy)
                        max_z = max(max_z, pz + dz)
                except Exception:
                    pass

        if min_x != float('inf'):
            bbox = {
                'min': {'x': round(min_x, 3), 'y': round(min_y, 3), 'z': round(min_z, 3)},
                'max': {'x': round(max_x, 3), 'y': round(max_y, 3), 'z': round(max_z, 3)},
                'mode': bbox_mode,
            }
            max_dim = max(max_x - min_x, max_y - min_y, max_z - min_z)
            if max_dim > 50000:
                errors.append(f"Bounding box exceeds 50km: {max_dim:.0f}m")

        print(f"IFC validation: {len(products)} products, {len(errors)} errors, "
              f"{len(warnings)} warnings, bbox_mode={bbox_mode}")

    except Exception as e:
        errors.append(f"Validation error: {str(e)}")

    # Store validation report to S3
    report = {
        'valid': len(errors) == 0,
        'errors': errors,
        'warnings': warnings,
        'elementSummary': element_summary,
        'bbox': bbox,
        'compatibilityScore': compatibility_score if 'compatibility_score' in dir() else None,
        'compatibilityIssues': compatibility_issues if 'compatibility_issues' in dir() else [],
        'meshFallbackCount': mesh_fallback_count if 'mesh_fallback_count' in dir() else 0,
        'proxyFallbackCount': proxy_fallback_count if 'proxy_fallback_count' in dir() else 0,
    }
    try:
        report_key = f'uploads/{user_id}/{render_id}/reports/validation_report.json'
        s3_client.put_object(Bucket=DATA_BUCKET, Key=report_key,
                             Body=json.dumps(report, indent=2).encode('utf-8'),
                             ContentType='application/json')
        print(f"Validation report stored: {report_key}")
    except Exception as e:
        print(f"Warning: Failed to store validation report: {e}")

    return len(errors) == 0, errors, warnings, element_summary, bbox


# ============================================================================
# LAMBDA HANDLER
# ============================================================================

def handler(event, context):
    """Lambda handler: CSS → IFC4 conversion with caching, validation, and self-healing."""
    print(f"JsonToIFC input: {json.dumps(event)[:500]}")

    render_id = event.get('renderId')
    user_id = event.get('userId')

    # Load CSS from S3 (avoids Step Function 256KB state limit)
    css_s3_key = event.get('cssS3Key')
    data_bucket = event.get('bucket', DATA_BUCKET)
    css = event.get('css')  # fallback for direct invocation

    if css_s3_key and not css:
        try:
            print(f"Loading CSS from S3: s3://{data_bucket}/{css_s3_key}")
            response = s3_client.get_object(Bucket=data_bucket, Key=css_s3_key)
            css = json.loads(response['Body'].read().decode('utf-8'))
            print(f"CSS loaded: {len(css.get('elements', []))} elements")
        except Exception as e:
            raise ValueError(f'Failed to load CSS from S3: {e}')

    if not css:
        raise ValueError('No CSS provided (neither cssS3Key nor css in event)')

    if css.get('cssVersion') != '1.0':
        print(f"Warning: unexpected CSS version: {css.get('cssVersion')}")

    metadata = css.get('metadata', {})
    output_mode = metadata.get('outputMode', 'HYBRID')

    # Check cache
    css_hash = compute_css_hash(css)
    cached_ifc = check_cache(css_hash)

    if cached_ifc:
        ifc_content = cached_ifc
    else:
        ifc_content, element_count, error_count = generate_ifc4_from_css(css)
        store_cache(css_hash, ifc_content)

    print(f'IFC size: {len(ifc_content)} bytes')

    # Validate IFC inline
    ifc_valid, val_errors, val_warnings, element_summary, ifc_bbox = validate_ifc(ifc_content, user_id, render_id)

    # Self-healing: if invalid and not already PROXY_ONLY, regenerate
    if not ifc_valid and output_mode != 'PROXY_ONLY':
        print(f'IFC validation failed ({len(val_errors)} errors), regenerating as PROXY_ONLY...')
        css['metadata']['outputMode'] = 'PROXY_ONLY'
        output_mode = 'PROXY_ONLY'

        ifc_content, element_count, error_count = generate_ifc4_from_css(css)
        css_hash = compute_css_hash(css)
        store_cache(css_hash, ifc_content)

        # Re-validate
        ifc_valid, val_errors, val_warnings, element_summary, ifc_bbox = validate_ifc(ifc_content, user_id, render_id)
        print(f'PROXY_ONLY regeneration: valid={ifc_valid}')

    # Save IFC to render path in S3
    bucket = IFC_BUCKET
    s3_key = f'{user_id}/{render_id}/model.ifc'

    try:
        s3_client.put_object(Bucket=bucket, Key=s3_key, Body=ifc_content.encode('utf-8'), ContentType='text/plain')
        print(f'IFC saved to S3: s3://{bucket}/{s3_key}')
    except Exception as s3_error:
        raise RuntimeError(f'Failed to save IFC to S3: {s3_error}')

    return {
        'renderId': render_id,
        'userId': user_id,
        'ifcGenerated': True,
        'ifcValid': ifc_valid,
        'ifcSizeBytes': len(ifc_content),
        'ifcS3Path': f's3://{bucket}/{s3_key}',
        'elementCounts': element_summary or metadata.get('elementCounts', {}),
        'bbox': ifc_bbox or metadata.get('bbox', {}),
        'outputMode': output_mode,
        'cssHash': css_hash,
        'status': 'IFC generated, validated, and saved to S3'
    }
