"""
Generate IFC4 using IfcOpenShell with rich architectural detail.
Supports multiple building types (office, warehouse, tunnel, parking, industrial, etc.)
with proper materials, property sets, element types, and spatial hierarchy.
"""

import json
import os
from datetime import datetime, timezone
import boto3

try:
    import ifcopenshell
    import ifcopenshell.guid
except Exception as e:
    raise RuntimeError(f"IfcOpenShell not available in runtime: {e}")

s3_client = boto3.client('s3')


# ============================================================================
# CONSTANTS & MATERIAL LIBRARY
# ============================================================================

MATERIAL_COLORS = {
    # Structural materials
    'concrete': (0.75, 0.75, 0.75),           # light gray
    'brick': (0.72, 0.36, 0.22),               # brick red
    'steel': (0.55, 0.60, 0.65),               # blue-gray
    'timber': (0.65, 0.45, 0.25),              # brown
    'glass': (0.7, 0.85, 0.95),                # light blue
    'concrete_floor': (0.65, 0.65, 0.65),     # medium gray
    'metal_roof': (0.40, 0.45, 0.50),         # dark steel
    'membrane': (0.30, 0.30, 0.30),            # dark gray
    'tiles': (0.50, 0.50, 0.55),               # slate gray
    'screed': (0.58, 0.58, 0.58),              # medium gray
    # Space materials (semi-transparent)
    'space_office': (0.9, 0.95, 1.0),
    'space_mechanical': (1.0, 0.9, 0.8),
    'space_electrical': (0.95, 0.85, 0.9),
    'space_storage': (0.9, 0.85, 0.75),
    'space_circulation': (0.85, 0.85, 0.85),
    'space_parking': (0.8, 0.85, 0.9),
    'space_other': (0.88, 0.88, 0.88),
    # Equipment colors by type
    'equipment_generator': (0.9, 0.8, 0.1),      # yellow
    'equipment_pump': (0.2, 0.5, 0.9),           # blue
    'equipment_fan': (0.3, 0.7, 0.4),             # green
    'equipment_compressor': (0.6, 0.3, 0.7),     # purple
    'equipment_transformer': (0.85, 0.2, 0.2),   # red
    'equipment_battery': (0.2, 0.6, 0.6),         # teal
    'equipment_converter': (0.7, 0.6, 0.1),       # olive
    'equipment_boiler': (0.9, 0.4, 0.1),          # orange
    'equipment_chiller': (0.1, 0.4, 0.8),         # dark blue
    'equipment_ahu': (0.5, 0.7, 0.5),             # sage green
    'equipment_default': (0.6, 0.6, 0.6),         # gray
    'door': (0.55, 0.40, 0.25),                   # wood brown
    'window': (0.7, 0.85, 0.95),                  # glass blue
}

EQUIPMENT_IFC_TYPE = {
    'GENERATOR': 'IfcElectricGenerator',
    'PUMP': 'IfcPump',
    'FAN': 'IfcFan',
    'COMPRESSOR': 'IfcCompressor',
    'TRANSFORMER': 'IfcTransformer',
    'BATTERY': 'IfcElectricDistributionBoard',
    'CONVERTER': 'IfcConverter',
    'BOILER': 'IfcBoiler',
    'CHILLER': 'IfcChiller',
    'AHU': 'IfcUnitaryEquipment',
}

EQUIPMENT_SIZES = {
    'GENERATOR': (2.0, 1.5, 1.5),
    'PUMP': (1.0, 0.8, 1.0),
    'FAN': (1.5, 1.0, 0.5),
    'COMPRESSOR': (1.5, 1.0, 1.5),
    'TRANSFORMER': (2.0, 1.5, 2.0),
    'BATTERY': (1.0, 0.8, 0.8),
    'CONVERTER': (1.0, 0.6, 1.0),
    'BOILER': (2.0, 1.2, 1.5),
    'CHILLER': (2.5, 2.0, 1.8),
    'AHU': (3.0, 1.5, 1.5),
}

SPACE_USAGE_COLORS = {
    'OFFICE': 'space_office',
    'STORAGE': 'space_storage',
    'MECHANICAL': 'space_mechanical',
    'ELECTRICAL': 'space_electrical',
    'CIRCULATION': 'space_circulation',
    'WC': 'space_circulation',
    'LOBBY': 'space_circulation',
    'LAB': 'space_office',
    'PARKING': 'space_parking',
    'OTHER': 'space_other',
}


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def new_guid():
    """Generate proper IFC GUID (22-char compressed)."""
    return ifcopenshell.guid.new()


def apply_style(f, solid, color_rgb, transparency=0.0, entity_name=None):
    """Apply color style to a geometry solid."""
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
    """Create and associate a property set to an element.
    properties_dict: {name: (value, ifc_type_name), ...}
    ifc_type_name: 'IfcBoolean', 'IfcLabel', 'IfcReal', 'IfcText', 'IfcInteger'
    """
    props = []
    for prop_name, (prop_value, ifc_type) in properties_dict.items():
        if ifc_type == 'IfcBoolean':
            nominal = f.create_entity('IfcBoolean', wrappedValue=prop_value)
        elif ifc_type == 'IfcReal':
            nominal = f.create_entity('IfcReal', wrappedValue=float(prop_value))
        elif ifc_type == 'IfcInteger':
            nominal = f.create_entity('IfcInteger', wrappedValue=int(prop_value))
        else:  # IfcLabel, IfcText default to Label
            nominal = f.create_entity('IfcLabel', wrappedValue=str(prop_value))

        prop = f.create_entity(
            'IfcPropertySingleValue',
            Name=prop_name,
            NominalValue=nominal
        )
        props.append(prop)

    pset = f.create_entity(
        'IfcPropertySet',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=pset_name,
        HasProperties=tuple(props)
    )

    f.create_entity(
        'IfcRelDefinesByProperties',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatedObjects=(element,),
        RelatingPropertyDefinition=pset
    )


def add_quantity_set(f, owner, element, qset_name, quantities_dict):
    """Create and associate a quantity set to an element.
    quantities_dict: {name: (value, ifc_quantity_type), ...}
    ifc_quantity_type: 'IfcQuantityLength', 'IfcQuantityArea', 'IfcQuantityVolume'
    """
    quants = []
    for quant_name, (quant_value, quant_type) in quantities_dict.items():
        if quant_type == 'IfcQuantityLength':
            quant = f.create_entity(
                'IfcQuantityLength',
                Name=quant_name,
                LengthValue=float(quant_value)
            )
        elif quant_type == 'IfcQuantityArea':
            quant = f.create_entity(
                'IfcQuantityArea',
                Name=quant_name,
                AreaValue=float(quant_value)
            )
        elif quant_type == 'IfcQuantityVolume':
            quant = f.create_entity(
                'IfcQuantityVolume',
                Name=quant_name,
                VolumeValue=float(quant_value)
            )
        else:
            continue
        quants.append(quant)

    if quants:
        qset = f.create_entity(
            'IfcElementQuantity',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=qset_name,
            Quantities=tuple(quants)
        )
        f.create_entity(
            'IfcRelDefinesByProperties',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            RelatedObjects=(element,),
            RelatingPropertyDefinition=qset
        )


def create_rectangular_solid(f, length, width, height, base_placement, subcontext, owner):
    """Create a rectangular extrusion solid and return (solid, body_rep, pds)."""
    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))

    # Create profile
    prof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
    prof_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
    prof_place = f.create_entity('IfcAxis2Placement2D', Location=prof_origin, RefDirection=prof_x)
    profile = f.create_entity(
        'IfcRectangleProfileDef',
        ProfileType='AREA',
        XDim=length,
        YDim=width,
        Position=prof_place
    )

    # Sweep
    solid_pos = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)
    extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    solid = f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile,
        Position=solid_pos,
        ExtrudedDirection=extrude_dir,
        Depth=height
    )

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='SweptSolid',
        Items=(solid,)
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))

    return solid, body_rep, pds


# ============================================================================
# BUILDING ENVELOPE CREATION (TYPE-SPECIFIC)
# ============================================================================

def create_building_walls(f, subcontext, owner, parent_lp, length_m, width_m, height_m, wall_thickness_m, axis_subcontext=None):
    """Create 4 exterior walls (N, S, E, W) as IfcWallStandardCase entities with axis representation."""
    walls = []
    mat_color = MATERIAL_COLORS.get('concrete', (0.75, 0.75, 0.75))

    # Helper to create one wall
    def make_wall(name, x_pos, y_pos, w_length, w_width, w_height):
        # Create body solid
        solid, body_rep, _ = create_rectangular_solid(f, w_length, w_width, w_height, None, subcontext, owner)
        apply_style(f, solid, mat_color, transparency=0.0, entity_name=name)

        # Create axis (2D centerline at mid-width)
        if axis_subcontext:
            axis_pt1 = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, w_width / 2.0))
            axis_pt2 = f.create_entity('IfcCartesianPoint', Coordinates=(w_length, w_width / 2.0))
            axis_curve = f.create_entity('IfcPolyline', Points=(axis_pt1, axis_pt2))
            axis_rep = f.create_entity(
                'IfcShapeRepresentation',
                ContextOfItems=axis_subcontext,
                RepresentationIdentifier='Axis',
                RepresentationType='Curve2D',
                Items=(axis_curve,)
            )
            # Combine axis + body representations
            pds = f.create_entity('IfcProductDefinitionShape', Representations=(axis_rep, body_rep))
        else:
            _, _, pds = create_rectangular_solid(f, w_length, w_width, w_height, None, subcontext, owner)

        wall_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_pos, y_pos, 0.0))
        axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
        refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
        wall_place = f.create_entity('IfcAxis2Placement3D', Location=wall_origin, Axis=axis, RefDirection=refd)
        wall_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=wall_place)

        wall = f.create_entity(
            'IfcWallStandardCase',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=name,
            ObjectPlacement=wall_lp,
            Representation=pds,
            PredefinedType='SOLIDWALL'
        )

        # Add properties
        add_property_set(f, owner, wall, 'Pset_WallCommon', {
            'IsExternal': (True, 'IfcBoolean'),
            'LoadBearing': (True, 'IfcBoolean'),
            'FireRating': ('2HR', 'IfcLabel'),
            'ThermalTransmittance': (0.35, 'IfcReal'),
        })

        # Add quantity set
        add_quantity_set(f, owner, wall, 'Qto_WallBaseQuantities', {
            'Length': (w_length, 'IfcQuantityLength'),
            'Width': (wall_thickness_m, 'IfcQuantityLength'),
            'Height': (w_height, 'IfcQuantityLength'),
        })

        return wall

    # South wall (main facade)
    walls.append(make_wall('South Wall', 0.0, 0.0, length_m, wall_thickness_m, height_m))
    # North wall
    walls.append(make_wall('North Wall', 0.0, width_m - wall_thickness_m, length_m, wall_thickness_m, height_m))
    # East wall
    walls.append(make_wall('East Wall', length_m - wall_thickness_m, wall_thickness_m, wall_thickness_m, width_m - 2*wall_thickness_m, height_m))
    # West wall
    walls.append(make_wall('West Wall', 0.0, wall_thickness_m, wall_thickness_m, width_m - 2*wall_thickness_m, height_m))

    return walls


def create_floor_slab(f, subcontext, owner, parent_lp, length_m, width_m):
    """Create a floor slab (IfcSlab with FLOOR predefined type)."""
    mat_color = MATERIAL_COLORS.get('concrete_floor', (0.65, 0.65, 0.65))

    solid, _, pds = create_rectangular_solid(f, length_m, width_m, 0.2, None, subcontext, owner)
    apply_style(f, solid, mat_color, transparency=0.0, entity_name='Floor Slab')

    floor_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    floor_place = f.create_entity('IfcAxis2Placement3D', Location=floor_origin, Axis=axis, RefDirection=refd)
    floor_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=floor_place)

    floor = f.create_entity(
        'IfcSlab',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Floor Slab',
        ObjectPlacement=floor_lp,
        Representation=pds,
        PredefinedType='FLOOR'
    )

    add_property_set(f, owner, floor, 'Pset_SlabCommon', {
        'IsExternal': (False, 'IfcBoolean'),
        'LoadBearing': (True, 'IfcBoolean'),
        'PitchAngle': (0.0, 'IfcReal'),
    })

    add_quantity_set(f, owner, floor, 'Qto_SlabBaseQuantities', {
        'GrossArea': (length_m * width_m, 'IfcQuantityArea'),
        'NetVolume': (length_m * width_m * 0.2, 'IfcQuantityVolume'),
    })

    return floor


def create_interior_wall(f, subcontext, owner, parent_lp, wall_data, mat_color=None):
    """Create an interior partition wall from start to end coordinates."""
    name = wall_data.get('name', 'Interior Wall')
    x_start = float(wall_data.get('x_start_m', 0.0))
    y_start = float(wall_data.get('y_start_m', 0.0))
    x_end = float(wall_data.get('x_end_m', 10.0))
    y_end = float(wall_data.get('y_end_m', 0.0))
    height = float(wall_data.get('height_m', 3.0))
    thickness = float(wall_data.get('thickness_m', 0.15))

    # Calculate wall length and angle
    length = ((x_end - x_start)**2 + (y_end - y_start)**2)**0.5
    if length < 0.01:
        return None

    # Midpoint
    mid_x = (x_start + x_end) / 2.0
    mid_y = (y_start + y_end) / 2.0

    # Wall color
    if mat_color is None:
        mat_color = MATERIAL_COLORS.get('concrete', (0.75, 0.75, 0.75))

    solid, _, pds = create_rectangular_solid(f, length, thickness, height, None, subcontext, owner)
    apply_style(f, solid, mat_color, transparency=0.0, entity_name=name)

    # Calculate rotation angle
    import math
    dx = x_end - x_start
    dy = y_end - y_start
    angle = math.atan2(dy, dx)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)

    wall_origin = f.create_entity('IfcCartesianPoint', Coordinates=(mid_x, mid_y, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(cos_a, sin_a, 0.0))
    wall_place = f.create_entity('IfcAxis2Placement3D', Location=wall_origin, Axis=axis, RefDirection=refd)
    wall_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=wall_place)

    wall = f.create_entity(
        'IfcWallStandardCase',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectPlacement=wall_lp,
        Representation=pds,
        PredefinedType='SOLIDWALL'
    )

    add_property_set(f, owner, wall, 'Pset_WallCommon', {
        'IsExternal': (False, 'IfcBoolean'),
        'LoadBearing': (False, 'IfcBoolean'),
        'FireRating': ('1HR', 'IfcLabel'),
    })

    add_quantity_set(f, owner, wall, 'Qto_WallBaseQuantities', {
        'Length': (length, 'IfcQuantityLength'),
        'Width': (thickness, 'IfcQuantityLength'),
        'Height': (height, 'IfcQuantityLength'),
    })

    return wall


def create_column(f, subcontext, owner, parent_lp, x_m, y_m, height_m, size_m=0.4):
    """Create a structural column at given position."""
    name = f'Column_{x_m:.1f}_{y_m:.1f}'
    mat_color = MATERIAL_COLORS.get('steel', (0.55, 0.60, 0.65))

    solid, _, pds = create_rectangular_solid(f, size_m, size_m, height_m, None, subcontext, owner)
    apply_style(f, solid, mat_color, transparency=0.0, entity_name=name)

    col_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_m - size_m/2, y_m - size_m/2, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    col_place = f.create_entity('IfcAxis2Placement3D', Location=col_origin, Axis=axis, RefDirection=refd)
    col_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=col_place)

    column = f.create_entity(
        'IfcColumn',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectPlacement=col_lp,
        Representation=pds,
        PredefinedType='COLUMN'
    )

    add_property_set(f, owner, column, 'Pset_ColumnCommon', {
        'LoadBearing': (True, 'IfcBoolean'),
        'StructuralType': ('COLUMN', 'IfcLabel'),
    })

    add_quantity_set(f, owner, column, 'Qto_ColumnBaseQuantities', {
        'Width': (size_m, 'IfcQuantityLength'),
        'Depth': (size_m, 'IfcQuantityLength'),
        'Height': (height_m, 'IfcQuantityLength'),
    })

    return column


def create_structural_grid(f, subcontext, owner, parent_lp, grid_config, length_m, width_m, height_m):
    """Create structural columns based on grid configuration."""
    columns = []
    if not grid_config or len(grid_config) == 0:
        return columns

    grid = grid_config[0]
    x_spacing = float(grid.get('x_spacing_m', 9.0))
    y_spacing = float(grid.get('y_spacing_m', 9.0))
    col_size = float(grid.get('column_size_m', 0.4))

    # Generate columns in grid pattern
    x_pos = x_spacing / 2
    while x_pos < length_m:
        y_pos = y_spacing / 2
        while y_pos < width_m:
            col = create_column(f, subcontext, owner, parent_lp, x_pos, y_pos, height_m, col_size)
            if col:
                columns.append(col)
            y_pos += y_spacing
        x_pos += x_spacing

    return columns


def create_roof_slab(f, subcontext, owner, parent_lp, length_m, width_m, height_m):
    """Create a roof slab (IfcSlab with ROOF predefined type)."""
    mat_color = MATERIAL_COLORS.get('metal_roof', (0.40, 0.45, 0.50))

    solid, _, pds = create_rectangular_solid(f, length_m, width_m, 0.1, None, subcontext, owner)
    apply_style(f, solid, mat_color, transparency=0.0, entity_name='Roof Slab')

    roof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, height_m))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    roof_place = f.create_entity('IfcAxis2Placement3D', Location=roof_origin, Axis=axis, RefDirection=refd)
    roof_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=roof_place)

    roof = f.create_entity(
        'IfcSlab',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Roof Slab',
        ObjectPlacement=roof_lp,
        Representation=pds,
        PredefinedType='ROOF'
    )

    add_property_set(f, owner, roof, 'Pset_SlabCommon', {
        'IsExternal': (True, 'IfcBoolean'),
        'LoadBearing': (False, 'IfcBoolean'),
        'PitchAngle': (0.0, 'IfcReal'),
    })

    add_quantity_set(f, owner, roof, 'Qto_SlabBaseQuantities', {
        'GrossArea': (length_m * width_m, 'IfcQuantityArea'),
    })

    return roof


# ============================================================================
# SPACES (ROOMS)
# ============================================================================

def create_space(f, subcontext, owner, parent_lp, room_data, idx):
    """Create a room as an IfcSpace."""
    name = room_data.get('name', f'Room {idx}')
    usage = room_data.get('usage', 'OTHER')
    length = float(room_data.get('length_m', 10.0))
    width = float(room_data.get('width_m', 8.0))
    height = float(room_data.get('height_m', 3.0))
    x_pos = float(room_data.get('x_position_m', 0.0))
    y_pos = float(room_data.get('y_position_m', 0.0))

    # Get color based on usage
    color_key = SPACE_USAGE_COLORS.get(usage, 'space_other')
    mat_color = MATERIAL_COLORS.get(color_key, (0.88, 0.88, 0.88))

    solid, _, pds = create_rectangular_solid(f, length, width, height, None, subcontext, owner)
    apply_style(f, solid, mat_color, transparency=0.3, entity_name=name)

    space_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_pos, y_pos, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    space_place = f.create_entity('IfcAxis2Placement3D', Location=space_origin, Axis=axis, RefDirection=refd)
    space_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=space_place)

    space = f.create_entity(
        'IfcSpace',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectPlacement=space_lp,
        Representation=pds,
        ObjectType=usage
    )

    add_property_set(f, owner, space, 'Pset_SpaceCommon', {
        'IsExternal': (False, 'IfcBoolean'),
        'NetFloorArea': (length * width, 'IfcReal'),
    })

    add_quantity_set(f, owner, space, 'Qto_SpaceBaseQuantities', {
        'NetFloorArea': (length * width, 'IfcQuantityArea'),
        'GrossVolume': (length * width * height, 'IfcQuantityVolume'),
        'Height': (height, 'IfcQuantityLength'),
    })

    return space


# ============================================================================
# EQUIPMENT
# ============================================================================

def create_equipment_element(f, subcontext, owner, parent_lp, equip_data, idx):
    """Create equipment as appropriate IFC entity (IfcPump, IfcFan, etc.)."""
    name = equip_data.get('name', f'Equipment {idx}')
    equip_type = equip_data.get('type', 'OTHER')
    x_pos = float(equip_data.get('x_position_m', 0.0))
    y_pos = float(equip_data.get('y_position_m', 0.0))

    # Get dimensions from spec or use defaults
    if equip_data.get('length_m') and equip_data.get('width_m') and equip_data.get('height_m'):
        length = float(equip_data.get('length_m'))
        width = float(equip_data.get('width_m'))
        height = float(equip_data.get('height_m'))
    else:
        length, width, height = EQUIPMENT_SIZES.get(equip_type, (1.0, 1.0, 1.0))

    # Color based on type
    color_key = f'equipment_{equip_type.lower()}' if equip_type.lower() in MATERIAL_COLORS else 'equipment_default'
    mat_color = MATERIAL_COLORS.get(color_key, (0.6, 0.6, 0.6))

    solid, _, pds = create_rectangular_solid(f, length, width, height, None, subcontext, owner)
    apply_style(f, solid, mat_color, transparency=0.0, entity_name=name)

    equip_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_pos, y_pos, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    equip_place = f.create_entity('IfcAxis2Placement3D', Location=equip_origin, Axis=axis, RefDirection=refd)
    equip_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=equip_place)

    # Determine IFC entity type
    ifc_entity_type = EQUIPMENT_IFC_TYPE.get(equip_type, 'IfcBuildingElementProxy')

    elem = f.create_entity(
        ifc_entity_type,
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectPlacement=equip_lp,
        Representation=pds,
        ObjectType=equip_type if ifc_entity_type == 'IfcBuildingElementProxy' else None
    )

    add_property_set(f, owner, elem, 'Pset_ManufacturerTypeInformation', {
        'Manufacturer': ('Generic', 'IfcLabel'),
        'ModelLabel': (equip_type, 'IfcLabel'),
    })

    # Add distribution ports for MEP equipment (HVAC, fluid, electrical connections)
    if equip_type in ['FAN', 'PUMP', 'COMPRESSOR', 'BOILER', 'CHILLER', 'AHU']:
        try:
            # Inlet/intake port
            inlet_port = create_distribution_port(f, owner, elem, port_type='INLET', location_xyz=(x_pos, y_pos, height/2))
            # Outlet/exhaust port
            outlet_port = create_distribution_port(f, owner, elem, port_type='OUTLET', location_xyz=(x_pos + length, y_pos, height/2))
        except Exception as e:
            print(f"Warning: Could not create distribution ports for {name}: {e}")

    return elem


# ============================================================================
# VENTILATION
# ============================================================================

def create_distribution_port(f, owner, parent_element, port_type='INLET', location_xyz=(0.0, 0.0, 0.0)):
    """Create a distribution port for MEP connections (HVAC, electrical, plumbing)."""
    port_name = f'{port_type}_Port'

    port = f.create_entity(
        'IfcDistributionPort',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=port_name,
        FlowDirection=port_type
    )

    f.create_entity(
        'IfcRelConnectsPortToElement',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatingPort=port,
        RelatedElement=parent_element
    )

    return port


def create_ventilation_elements(f, subcontext, owner, parent_lp, ventilation_data, length_m, width_m):
    """Create IfcFlowTerminal elements for ventilation intake/exhaust."""
    elements = []

    intake_loc = ventilation_data.get('intake_location', 'West')
    exhaust_loc = ventilation_data.get('exhaust_location', 'East')
    num_fans = int(ventilation_data.get('num_fans', 1))

    # Helper to create air terminal
    def make_terminal(name, wall_side, x_pos, y_pos):
        solid, _, pds = create_rectangular_solid(f, 0.5, 0.5, 0.3, None, subcontext, owner)
        apply_style(f, solid, (0.4, 0.4, 0.8), transparency=0.1, entity_name=name)

        term_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_pos, y_pos, 0.5))
        axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
        refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
        term_place = f.create_entity('IfcAxis2Placement3D', Location=term_origin, Axis=axis, RefDirection=refd)
        term_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=term_place)

        terminal = f.create_entity(
            'IfcFlowTerminal',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=name,
            ObjectPlacement=term_lp,
            Representation=pds,
            ObjectType=wall_side
        )

        add_property_set(f, owner, terminal, 'Pset_AirTerminalCommon', {
            'AirFlowType': ('EXHAUST' if 'Exhaust' in name else 'SUPPLY', 'IfcLabel'),
        })

        return terminal

    # Intake terminals
    if num_fans == 1:
        if intake_loc.lower() == 'west':
            elements.append(make_terminal('Intake Terminal', 'West', 0.5, width_m / 2))
        elif intake_loc.lower() == 'east':
            elements.append(make_terminal('Intake Terminal', 'East', length_m - 0.5, width_m / 2))
        elif intake_loc.lower() == 'north':
            elements.append(make_terminal('Intake Terminal', 'North', length_m / 2, width_m - 0.5))
        else:  # south
            elements.append(make_terminal('Intake Terminal', 'South', length_m / 2, 0.5))
    else:
        # Distribute multiple fans along wall
        for i in range(num_fans):
            offset = (i + 1) * (length_m / (num_fans + 1))
            if intake_loc.lower() == 'west':
                elements.append(make_terminal(f'Intake Terminal {i+1}', 'West', 0.5, offset))
            else:
                elements.append(make_terminal(f'Intake Terminal {i+1}', intake_loc, offset, 0.5))

    # Exhaust terminals
    if exhaust_loc.lower() == 'west':
        elements.append(make_terminal('Exhaust Terminal', 'West', 0.5, width_m / 2 + 2.0))
    elif exhaust_loc.lower() == 'east':
        elements.append(make_terminal('Exhaust Terminal', 'East', length_m - 0.5, width_m / 2 + 2.0))
    elif exhaust_loc.lower() == 'north':
        elements.append(make_terminal('Exhaust Terminal', 'North', length_m / 2 + 2.0, width_m - 0.5))
    else:  # south
        elements.append(make_terminal('Exhaust Terminal', 'South', length_m / 2 + 2.0, 0.5))

    return elements


# ============================================================================
# OPENINGS (DOORS & WINDOWS)
# ============================================================================

def create_default_door(f, subcontext, owner, parent_lp, length_m, width_m, host_wall=None):
    """Create a default door on the south wall with opening element."""
    door_width = 1.0
    door_height = 2.1

    # Opening geometry
    opening_solid, _, opening_pds = create_rectangular_solid(f, door_width, 0.1, door_height, None, subcontext, owner)
    apply_style(f, opening_solid, (0.9, 0.9, 0.9), transparency=0.0, entity_name='Door Opening')

    door_origin = f.create_entity('IfcCartesianPoint', Coordinates=(length_m / 2 - 0.5, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    door_place = f.create_entity('IfcAxis2Placement3D', Location=door_origin, Axis=axis, RefDirection=refd)
    door_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=door_place)

    # Create opening element
    opening = f.create_entity(
        'IfcOpeningElement',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Door Opening',
        ObjectPlacement=door_lp,
        Representation=opening_pds
    )

    # Relate opening to host wall
    if host_wall:
        f.create_entity(
            'IfcRelVoidsElement',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            RelatingBuildingElement=host_wall,
            RelatedOpeningElement=opening
        )

    # Door door geometry
    door_solid, _, door_pds = create_rectangular_solid(f, door_width, 0.05, door_height, None, subcontext, owner)
    apply_style(f, door_solid, MATERIAL_COLORS['door'], transparency=0.0, entity_name='Main Door')

    door = f.create_entity(
        'IfcDoor',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Main Door',
        ObjectPlacement=door_lp,
        Representation=door_pds,
        PredefinedType='SWINGDOOR',
        OverallHeight=door_height,
        OverallWidth=door_width
    )

    # Relate door to opening
    f.create_entity(
        'IfcRelFillsElement',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatingOpeningElement=opening,
        RelatedBuildingElement=door
    )

    add_property_set(f, owner, door, 'Pset_DoorCommon', {
        'IsExternal': (True, 'IfcBoolean'),
        'FireExit': (False, 'IfcBoolean'),
    })

    # Add door lining properties
    lining = f.create_entity(
        'IfcDoorLiningProperties',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Door Lining',
        LiningDepth=0.05,
        LiningThickness=0.05
    )
    f.create_entity(
        'IfcRelDefinesByProperties',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatedObjects=(door,),
        RelatingPropertyDefinition=lining
    )

    # Add door panel properties
    panel = f.create_entity(
        'IfcDoorPanelProperties',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Door Panel',
        PanelDepth=0.04,
        PanelOperation='SWINGING'
    )
    f.create_entity(
        'IfcRelDefinesByProperties',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatedObjects=(door,),
        RelatingPropertyDefinition=panel
    )

    return door, opening


# ============================================================================
# TUNNEL BRANCH GENERATION (VENTSIM)
# ============================================================================

def compute_direction_vector(x1, y1, z1, x2, y2, z2):
    """Compute direction vector from point 1 to point 2, normalized."""
    dx = x2 - x1
    dy = y2 - y1
    dz = z2 - z1
    length = (dx**2 + dy**2 + dz**2)**0.5

    if length < 0.01:
        return (1.0, 0.0, 0.0), 0.0  # Degenerate case

    return (dx/length, dy/length, dz/length), length


def compute_perpendicular_direction(dir_x, dir_y, dir_z):
    """Compute a perpendicular direction vector using cross product."""
    import math

    # Choose a non-parallel reference vector
    if abs(dir_z) < 0.9:
        # Direction is mostly horizontal, use Z-axis as reference
        ref_x, ref_y, ref_z = 0.0, 0.0, 1.0
    else:
        # Direction is mostly vertical, use X-axis as reference
        ref_x, ref_y, ref_z = 1.0, 0.0, 0.0

    # Cross product: direction × reference
    perp_x = dir_y * ref_z - dir_z * ref_y
    perp_y = dir_z * ref_x - dir_x * ref_z
    perp_z = dir_x * ref_y - dir_y * ref_x

    # Normalize
    length = (perp_x**2 + perp_y**2 + perp_z**2)**0.5
    if length < 0.01:
        return (1.0, 0.0, 0.0)

    return (perp_x/length, perp_y/length, perp_z/length)


def create_tunnel_branch(f, subcontext, owner, parent_lp, branch, z_offset=0.0):
    """Create an IFC element for a tunnel branch (rectangular or circular duct)."""
    try:
        name = branch.get('name', 'Branch')
        x1 = float(branch.get('x1', 0.0))
        y1 = float(branch.get('y1', 0.0))
        z1 = float(branch.get('z1', 0.0))
        x2 = float(branch.get('x2', 0.0))
        y2 = float(branch.get('y2', 0.0))
        z2 = float(branch.get('z2', 0.0))
        width = float(branch.get('width', 1.0))
        height = float(branch.get('height', 1.0))
        shape_type = int(branch.get('shape_type', 0))  # 0=rect, 1=round
        liner_type = int(branch.get('liner_type', 1))  # 0=blasted, 1=concrete_lined

        # Compute direction vector and length
        dir_vec, length = compute_direction_vector(x1, y1, z1, x2, y2, z2)

        if length < 0.1:
            return None  # Skip degenerate branches

        # Compute perpendicular reference direction
        ref_dir = compute_perpendicular_direction(dir_vec[0], dir_vec[1], dir_vec[2])

        # Select material color based on liner type and shape
        if shape_type == 1:  # Round duct
            mat_color = (0.40, 0.50, 0.65)  # Blue-grey for ductwork
        elif liner_type == 0:  # Blasted rock
            mat_color = (0.45, 0.40, 0.38)  # Darker grey
        else:  # Concrete lined
            mat_color = (0.75, 0.75, 0.73)  # Light grey

        # Create profile based on shape
        profile_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
        profile_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
        profile_place = f.create_entity('IfcAxis2Placement2D', Location=profile_origin, RefDirection=profile_x)

        if shape_type == 1:  # Round
            radius = width / 2.0
            profile = f.create_entity(
                'IfcCircleProfileDef',
                ProfileType='AREA',
                Radius=radius,
                Position=profile_place
            )
        else:  # Rectangular
            profile = f.create_entity(
                'IfcRectangleProfileDef',
                ProfileType='AREA',
                XDim=width,
                YDim=height,
                Position=profile_place
            )

        # Create extrusion geometry (base at origin, extrude along local Z)
        origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
        extrude_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
        ref_dir_entity = f.create_entity('IfcDirection', DirectionRatios=ref_dir)
        solid_place = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=extrude_axis, RefDirection=ref_dir_entity)

        extrude_dir = f.create_entity('IfcDirection', DirectionRatios=dir_vec)
        solid = f.create_entity(
            'IfcExtrudedAreaSolid',
            SweptArea=profile,
            Position=solid_place,
            ExtrudedDirection=extrude_dir,
            Depth=length
        )

        apply_style(f, solid, mat_color, transparency=0.0, entity_name=name)

        body_rep = f.create_entity(
            'IfcShapeRepresentation',
            ContextOfItems=subcontext,
            RepresentationIdentifier='Body',
            RepresentationType='SweptSolid',
            Items=(solid,)
        )
        pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))

        # Placement at branch start position (normalized coordinates)
        branch_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x1, y1, z1 - z_offset))
        branch_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
        branch_refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
        branch_place = f.create_entity('IfcAxis2Placement3D', Location=branch_origin, Axis=branch_axis, RefDirection=branch_refd)
        branch_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=branch_place)

        # Create IFC element
        if shape_type == 1:  # Round ductwork → use IfcMember
            element = f.create_entity(
                'IfcMember',
                GlobalId=new_guid(),
                OwnerHistory=owner,
                Name=name,
                ObjectPlacement=branch_lp,
                Representation=pds
            )
        else:  # Rectangular → use IfcWallStandardCase
            element = f.create_entity(
                'IfcWallStandardCase',
                GlobalId=new_guid(),
                OwnerHistory=owner,
                Name=name,
                ObjectPlacement=branch_lp,
                Representation=pds,
                PredefinedType='SOLIDWALL'
            )

        # Add property set
        add_property_set(f, owner, element, 'Pset_TunnelBranchData', {
            'Width': (width, 'IfcReal'),
            'Height': (height, 'IfcReal'),
            'Area': (width * height if shape_type == 0 else 3.14159 * (width/2)**2, 'IfcReal'),
            'ShapeType': ('Round' if shape_type == 1 else 'Rectangular', 'IfcLabel'),
            'LinerType': ('Concrete' if liner_type == 1 else 'Blasted', 'IfcLabel'),
        })

        # Add quantity set
        add_quantity_set(f, owner, element, 'Qto_TunnelBranchQuantities', {
            'Length': (length, 'IfcQuantityLength'),
            'CrossSectionArea': (width * height if shape_type == 0 else 3.14159 * (width/2)**2, 'IfcQuantityArea'),
        })

        return element

    except Exception as e:
        print(f"Error creating tunnel branch {branch.get('name', 'Unknown')}: {e}")
        return None


def create_tunnel_branches(f, subcontext, owner, parent_lp, tunnel_branches, tunnel_bounds):
    """Create multiple IFC elements from tunnel branch data."""
    branches = []

    if not tunnel_branches or len(tunnel_branches) == 0:
        return branches

    # Get Z offset for normalization
    z_offset = tunnel_bounds.get('min_z', 0.0) if tunnel_bounds else 0.0
    min_x = tunnel_bounds.get('min_x', 0.0) if tunnel_bounds else 0.0
    min_y = tunnel_bounds.get('min_y', 0.0) if tunnel_bounds else 0.0

    for idx, branch in enumerate(tunnel_branches):
        try:
            # Normalize coordinates
            branch_normalized = {**branch}
            branch_normalized['x1'] = float(branch.get('x1', 0.0)) - min_x
            branch_normalized['y1'] = float(branch.get('y1', 0.0)) - min_y
            branch_normalized['x2'] = float(branch.get('x2', 0.0)) - min_x
            branch_normalized['y2'] = float(branch.get('y2', 0.0)) - min_y
            branch_normalized['z1'] = float(branch.get('z1', 0.0)) - z_offset
            branch_normalized['z2'] = float(branch.get('z2', 0.0)) - z_offset

            elem = create_tunnel_branch(f, subcontext, owner, parent_lp, branch_normalized, z_offset=0.0)
            if elem:
                branches.append(elem)
        except Exception as e:
            print(f"Error processing branch {idx}: {e}")

    print(f"Created {len(branches)} tunnel branch elements")
    return branches


# ============================================================================
# COVERINGS (CEILINGS)
# ============================================================================

def create_ceiling(f, subcontext, owner, parent_lp, length_m, width_m, height_m):
    """Create a ceiling as IfcCovering with FaceBasedSurfaceModel geometry."""
    mat_color = MATERIAL_COLORS.get('concrete_floor', (0.88, 0.88, 0.88))

    # 4 corner points of ceiling (at height)
    pt_sw = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, height_m))
    pt_se = f.create_entity('IfcCartesianPoint', Coordinates=(length_m, 0.0, height_m))
    pt_ne = f.create_entity('IfcCartesianPoint', Coordinates=(length_m, width_m, height_m))
    pt_nw = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, width_m, height_m))

    # Create polygon loop
    poly = f.create_entity('IfcPolyLoop', Polygon=(pt_sw, pt_se, pt_ne, pt_nw))
    bound = f.create_entity('IfcFaceOuterBound', Bound=poly, Orientation=True)
    face = f.create_entity('IfcFace', Bounds=(bound,))

    # Face-based surface model
    face_set = f.create_entity('IfcConnectedFaceSet', CfsFaces=(face,))
    surface_model = f.create_entity('IfcFaceBasedSurfaceModel', FbsmFaces=(face_set,))

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='SurfaceModel',
        Items=(surface_model,)
    )

    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    apply_style(f, surface_model, mat_color, transparency=0.0, entity_name='Ceiling')

    # Placement (at origin, geometry already has height)
    ceiling_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    ceiling_place = f.create_entity('IfcAxis2Placement3D', Location=ceiling_origin, Axis=axis, RefDirection=refd)
    ceiling_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=ceiling_place)

    ceiling = f.create_entity(
        'IfcCovering',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Ceiling',
        ObjectPlacement=ceiling_lp,
        Representation=pds,
        PredefinedType='CEILING'
    )

    add_property_set(f, owner, ceiling, 'Pset_CoveringCommon', {
        'FireRating': ('30 min', 'IfcLabel'),
    })

    return ceiling


# ============================================================================
# MAIN IFC4 GENERATOR
# ============================================================================

def create_material_layer_set(f, owner, material_name, layers_dict):
    """Create a material layer set for walls.
    layers_dict: {layer_name: (thickness_m, material_type), ...}
    Returns IfcMaterialLayerSet entity.
    """
    layers = []
    for layer_name, (thickness, mat_type) in layers_dict.items():
        mat = f.create_entity('IfcMaterial', Name=mat_type)
        layer = f.create_entity(
            'IfcMaterialLayer',
            Material=mat,
            LayerThickness=float(thickness),
            Name=layer_name
        )
        layers.append(layer)

    return f.create_entity(
        'IfcMaterialLayerSet',
        MaterialLayers=tuple(layers),
        LayerSetName=material_name
    )


def apply_material_layers_to_wall(f, owner, wall_element, material_layers_set):
    """Associate a material layer set with a wall element."""
    usage = f.create_entity(
        'IfcMaterialLayerSetUsage',
        ForLayerSet=material_layers_set,
        LayerSetDirection='AXIS2',
        DirectionSense='NEGATIVE',
        OffsetFromReferenceLine=0.0
    )

    f.create_entity(
        'IfcRelAssociatesMaterial',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatedObjects=(wall_element,),
        RelatingMaterial=usage
    )


def get_wall_layer_composition(wall_material='concrete', finish='plasterboard', insulation=None):
    """Get wall layer composition based on material and finish.
    Returns dict of {layer_name: (thickness_m, material_type), ...}
    """
    layers = {}

    # Structural core
    if wall_material.lower() == 'brick':
        layers['Brick_Core'] = (0.22, 'Brick Masonry')
    elif wall_material.lower() == 'steel':
        layers['Steel_Frame'] = (0.15, 'Steel Framing')
    else:  # concrete default
        layers['Concrete_Core'] = (0.20, 'Concrete C25')

    # Insulation (if specified)
    if insulation:
        if insulation.lower() == 'mineral_wool':
            layers['Insulation'] = (0.05, 'Mineral Wool')
        elif insulation.lower() == 'foam':
            layers['Insulation'] = (0.06, 'EPS Foam')
        else:
            layers['Insulation'] = (0.05, 'Insulation')

    # Finish
    if finish and finish.lower() == 'tiles':
        layers['Tile_Finish'] = (0.01, 'Ceramic Tiles')
    elif finish and finish.lower() == 'panels':
        layers['Panel_Finish'] = (0.025, 'Wood Panels')
    else:  # plasterboard default
        layers['Plasterboard_Finish'] = (0.015, 'Plasterboard')

    return layers


def create_openings(f, subcontext, owner, parent_lp, openings, length_m, width_m, height_m, walls=None):
    """Create door and window elements from opening specifications with IfcOpeningElement support."""
    opening_elements = []
    wall_by_side = {}
    if walls and len(walls) >= 4:
        wall_by_side = {
            'SOUTH': walls[0],
            'NORTH': walls[1],
            'EAST': walls[2],
            'WEST': walls[3],
        }

    for idx, opening in enumerate(openings):
        try:
            opening_type = opening.get('type', 'DOOR').upper()
            wall_side = opening.get('wall_side', 'SOUTH').upper()
            x_offset = float(opening.get('x_offset_m', 0.0))
            width = float(opening.get('width_m', 1.0 if opening_type == 'DOOR' else 1.5))
            height = float(opening.get('height_m', 2.1 if opening_type == 'DOOR' else 1.2))
            sill_height = float(opening.get('sill_height_m', 0.0 if opening_type == 'DOOR' else 0.9))

            if opening_type == 'DOOR':
                mat_color = MATERIAL_COLORS.get('door', (0.55, 0.40, 0.25))

                # Opening solid (void)
                opening_solid, _, opening_pds = create_rectangular_solid(f, width, 0.1, height, None, subcontext, owner)
                apply_style(f, opening_solid, (0.9, 0.9, 0.9), transparency=0.0, entity_name=f'Door_Opening_{idx}')

                # Door solid
                door_solid, _, door_pds = create_rectangular_solid(f, width, 0.05, height, None, subcontext, owner)
                apply_style(f, door_solid, mat_color, transparency=0.0, entity_name=f'Door_{idx}')

                # Position based on wall side
                if wall_side == 'SOUTH':
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_offset, 0.0, sill_height))
                elif wall_side == 'NORTH':
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_offset, width_m, sill_height))
                elif wall_side == 'EAST':
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(length_m, x_offset, sill_height))
                else:  # WEST
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, x_offset, sill_height))

                axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
                placement = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)
                lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=placement)

                # Create opening element
                opening = f.create_entity(
                    'IfcOpeningElement',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    Name=f'Door_Opening_{idx}',
                    ObjectPlacement=lp,
                    Representation=opening_pds
                )

                # Relate opening to host wall
                host_wall = wall_by_side.get(wall_side)
                if host_wall:
                    f.create_entity(
                        'IfcRelVoidsElement',
                        GlobalId=new_guid(),
                        OwnerHistory=owner,
                        RelatingBuildingElement=host_wall,
                        RelatedOpeningElement=opening
                    )

                door = f.create_entity(
                    'IfcDoor',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    Name=f'Door_{idx}',
                    ObjectPlacement=lp,
                    Representation=door_pds,
                    PredefinedType='SWINGDOOR',
                    OverallHeight=height,
                    OverallWidth=width
                )

                # Relate door to opening
                f.create_entity(
                    'IfcRelFillsElement',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    RelatingOpeningElement=opening,
                    RelatedBuildingElement=door
                )

                add_property_set(f, owner, door, 'Pset_DoorCommon', {
                    'IsExternal': (wall_side in ['NORTH', 'SOUTH', 'EAST', 'WEST'], 'IfcBoolean'),
                    'FireExit': (False, 'IfcBoolean'),
                })

                # Add door lining properties
                lining = f.create_entity(
                    'IfcDoorLiningProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    Name=f'Door_Lining_{idx}',
                    LiningDepth=0.05,
                    LiningThickness=0.05
                )
                f.create_entity(
                    'IfcRelDefinesByProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    RelatedObjects=(door,),
                    RelatingPropertyDefinition=lining
                )

                # Add door panel properties
                panel = f.create_entity(
                    'IfcDoorPanelProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    Name=f'Door_Panel_{idx}',
                    PanelDepth=0.04,
                    PanelOperation='SWINGING'
                )
                f.create_entity(
                    'IfcRelDefinesByProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    RelatedObjects=(door,),
                    RelatingPropertyDefinition=panel
                )

                opening_elements.append(door)
                opening_elements.append(opening)

            elif opening_type == 'WINDOW':
                mat_color = MATERIAL_COLORS.get('window', (0.7, 0.85, 0.95))
                solid, _, pds = create_rectangular_solid(f, width, 0.05, height, None, subcontext, owner)
                apply_style(f, solid, mat_color, transparency=0.3, entity_name=f'Window_{idx}')

                # Position based on wall side
                if wall_side == 'SOUTH':
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_offset, 0.0, sill_height))
                elif wall_side == 'NORTH':
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_offset, width_m, sill_height))
                elif wall_side == 'EAST':
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(length_m, x_offset, sill_height))
                else:  # WEST
                    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, x_offset, sill_height))

                axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
                placement = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)
                lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=placement)

                window = f.create_entity(
                    'IfcWindow',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    Name=f'Window_{idx}',
                    ObjectPlacement=lp,
                    Representation=pds,
                    PredefinedType='WINDOW',
                    OverallHeight=height,
                    OverallWidth=width
                )

                add_property_set(f, owner, window, 'Pset_WindowCommon', {
                    'IsExternal': (True, 'IfcBoolean'),
                    'FireRating': ('30 min', 'IfcLabel'),
                })

                # Add window lining properties
                lining = f.create_entity(
                    'IfcWindowLiningProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    Name=f'Window_Lining_{idx}',
                    FrameDepth=0.075,
                    FrameThickness=0.075
                )
                f.create_entity(
                    'IfcRelDefinesByProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    RelatedObjects=(window,),
                    RelatingPropertyDefinition=lining
                )

                # Add window panel properties
                panel = f.create_entity(
                    'IfcWindowPanelProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    Name=f'Window_Panel_{idx}',
                    FrameDepth=0.05
                )
                f.create_entity(
                    'IfcRelDefinesByProperties',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    RelatedObjects=(window,),
                    RelatingPropertyDefinition=panel
                )

                opening_elements.append(window)

        except Exception as e:
            print(f"Error creating opening {idx}: {e}")

    return opening_elements


def create_interior_walls_from_rooms(rooms, length_m, width_m, height_m):
    """Generate interior wall definitions based on room layout."""
    interior_walls = []

    if len(rooms) < 2:
        return interior_walls

    # Sort rooms by position to find adjacencies
    rooms_sorted = sorted(rooms, key=lambda r: (r.get('x_position_m', 0.0), r.get('y_position_m', 0.0)))

    for i, room in enumerate(rooms_sorted):
        x_pos = float(room.get('x_position_m', 0.0))
        y_pos = float(room.get('y_position_m', 0.0))
        room_length = float(room.get('length_m', 10.0))
        room_width = float(room.get('width_m', 8.0))
        room_height = float(room.get('height_m', 3.0))

        # Wall on east side of room (if not at building edge)
        if x_pos + room_length < length_m - 0.5:
            interior_walls.append({
                'name': f'Wall_{room.get("name", f"Room{i}")}_East',
                'x_start_m': x_pos + room_length,
                'y_start_m': y_pos,
                'x_end_m': x_pos + room_length,
                'y_end_m': y_pos + room_width,
                'height_m': room_height,
                'thickness_m': 0.12
            })

        # Wall on south side of room (if not at building edge)
        if y_pos > 0.5:
            interior_walls.append({
                'name': f'Wall_{room.get("name", f"Room{i}")}_South',
                'x_start_m': x_pos,
                'y_start_m': y_pos,
                'x_end_m': x_pos + room_length,
                'y_end_m': y_pos,
                'height_m': room_height,
                'thickness_m': 0.12
            })

    return interior_walls


def generate_ifc4(spec):
    """Generate IFC4 file using IfcOpenShell with rich architectural detail."""

    name = spec.get('buildingName', 'Building')
    building_type = spec.get('buildingType', 'BUILDING')
    ts = int(datetime.now(timezone.utc).timestamp())

    # Extract dimensions and elevations
    dims = spec.get('dimensions', {})
    length_m = float(dims.get('length_m', 100.0))
    width_m = float(dims.get('width_m', 50.0))
    height_m = float(dims.get('height_m', 6.0))
    wall_thickness_m = float(dims.get('wall_thickness_m', 0.3))

    elevations = spec.get('elevations', {})
    floor_level_m = float(elevations.get('floor_level_m', 0.0))

    rooms = spec.get('rooms', [])
    openings = spec.get('openings', [])
    equipment = spec.get('equipment', [])
    ventilation = spec.get('ventilation', {})
    materials = spec.get('materials', {})

    # Create IFC4 file
    f = ifcopenshell.file(schema='IFC4')

    # --- Owner History ---
    person = f.create_entity('IfcPerson', GivenName='Person')
    org = f.create_entity('IfcOrganization', Name='Org')
    pando = f.create_entity('IfcPersonAndOrganization', ThePerson=person, TheOrganization=org)
    app = f.create_entity(
        'IfcApplication',
        ApplicationDeveloper=org,
        Version='1.0',
        ApplicationFullName='JsonToIFC',
        ApplicationIdentifier='J2I',
    )
    owner = f.create_entity(
        'IfcOwnerHistory',
        OwningUser=pando,
        OwningApplication=app,
        ChangeAction='ADDED',
        CreationDate=ts
    )

    # --- Units ---
    u_len = f.create_entity('IfcSIUnit', UnitType='LENGTHUNIT', Name='METRE')
    u_area = f.create_entity('IfcSIUnit', UnitType='AREAUNIT', Name='SQUARE_METRE')
    u_vol = f.create_entity('IfcSIUnit', UnitType='VOLUMEUNIT', Name='CUBIC_METRE')
    u_ang = f.create_entity('IfcSIUnit', UnitType='PLANEANGLEUNIT', Name='RADIAN')
    units = f.create_entity('IfcUnitAssignment', Units=(u_len, u_area, u_vol, u_ang))

    # --- Geometry Context ---
    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    wcs = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)

    context = f.create_entity(
        'IfcGeometricRepresentationContext',
        ContextIdentifier='Model',
        ContextType='Model',
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=wcs,
    )

    # Subcontext for Body representation
    subcontext = f.create_entity(
        'IfcGeometricRepresentationSubContext',
        ContextIdentifier='Body',
        ContextType='Model',
        ParentContext=context,
        TargetView='MODEL_VIEW'
    )

    # Subcontext for Axis representation
    axis_subcontext = f.create_entity(
        'IfcGeometricRepresentationSubContext',
        ContextIdentifier='Axis',
        ContextType='Model',
        ParentContext=context,
        TargetView='MODEL_VIEW'
    )

    # --- Project ---
    project = f.create_entity(
        'IfcProject',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        RepresentationContexts=(context,),
        UnitsInContext=units,
    )

    # --- Spatial Structure ---
    proj_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=None, RelativePlacement=wcs)

    site = f.create_entity(
        'IfcSite',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Site',
        ObjectPlacement=proj_lp,
        CompositionType='ELEMENT'
    )

    bld_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=proj_lp, RelativePlacement=wcs)
    building = f.create_entity(
        'IfcBuilding',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectPlacement=bld_lp,
        CompositionType='ELEMENT'
    )

    lvl_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=bld_lp, RelativePlacement=wcs)
    storey = f.create_entity(
        'IfcBuildingStorey',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Level 1',
        ObjectPlacement=lvl_lp,
        CompositionType='ELEMENT',
        Elevation=floor_level_m
    )

    # Create aggregations
    f.create_entity(
        'IfcRelAggregates',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatingObject=project,
        RelatedObjects=(site,)
    )
    f.create_entity(
        'IfcRelAggregates',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatingObject=site,
        RelatedObjects=(building,)
    )
    f.create_entity(
        'IfcRelAggregates',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatingObject=building,
        RelatedObjects=(storey,)
    )

    # --- Create Building Envelope ---
    contained_elements = []

    # Check if this is a tunnel network (VentSim data)
    tunnel_branches = spec.get('tunnel_branches', [])
    tunnel_bounds = spec.get('tunnel_bounds', {})

    walls = []  # Initialize walls for both tunnel and standard modes
    if tunnel_branches and len(tunnel_branches) > 0:
        # VentSim tunnel mode: generate tunnel network elements
        print(f"Generating {len(tunnel_branches)} tunnel branch elements...")
        tunnel_elems = create_tunnel_branches(f, subcontext, owner, lvl_lp, tunnel_branches, tunnel_bounds)
        contained_elements.extend(tunnel_elems)
    else:
        # Standard building mode: create walls with material layers
        walls = create_building_walls(f, subcontext, owner, lvl_lp, length_m, width_m, height_m, wall_thickness_m, axis_subcontext)
        contained_elements.extend(walls)

    # Apply material layers to walls
    wall_material = materials.get('walls', 'concrete')
    wall_finish = materials.get('wall_finish', 'plasterboard')
    wall_insulation = materials.get('wall_insulation')

    wall_layers = get_wall_layer_composition(wall_material, wall_finish, wall_insulation)
    material_layer_set = create_material_layer_set(f, owner, f'Wall_Layers_{wall_material}', wall_layers)

    for wall in walls:
        apply_material_layers_to_wall(f, owner, wall, material_layer_set)

    if not tunnel_branches:
        # Only apply material layers for non-tunnel buildings
        print(f"Applied material layers to {len(walls)} exterior walls")

        # Create floor
        floor = create_floor_slab(f, subcontext, owner, lvl_lp, length_m, width_m)
        contained_elements.append(floor)

        # Create roof
        roof = create_roof_slab(f, subcontext, owner, lvl_lp, length_m, width_m, height_m)
        contained_elements.append(roof)

        # Create ceiling
        try:
            ceiling = create_ceiling(f, subcontext, owner, lvl_lp, length_m, width_m, height_m)
            contained_elements.append(ceiling)
        except Exception as e:
            print(f"Error creating ceiling: {e}")

    # --- Create Structural Elements ---
    # Create structural columns based on grid if defined
    structure_data = spec.get('structure', {})
    column_grid = structure_data.get('column_grid', [])
    if column_grid and len(column_grid) > 0:
        columns = create_structural_grid(f, subcontext, owner, lvl_lp, column_grid, length_m, width_m, height_m)
        contained_elements.extend(columns)
        print(f"Created {len(columns)} structural columns")

    # --- Create Interior Walls ---
    # Get interior walls from spec or generate from room layout
    interior_walls_spec = spec.get('interior_walls', [])
    if not interior_walls_spec or len(interior_walls_spec) == 0:
        # Auto-generate interior walls from room layout
        interior_walls_spec = create_interior_walls_from_rooms(rooms, length_m, width_m, height_m)

    for idx, iwall in enumerate(interior_walls_spec):
        try:
            wall_elem = create_interior_wall(f, subcontext, owner, lvl_lp, iwall)
            if wall_elem:
                contained_elements.append(wall_elem)
        except Exception as e:
            print(f"Error creating interior wall {idx}: {e}")

    # --- Create Rooms ---
    for idx, room in enumerate(rooms):
        try:
            room_elem = create_space(f, subcontext, owner, lvl_lp, room, idx)
            contained_elements.append(room_elem)
        except Exception as e:
            print(f"Error creating room {idx}: {e}")

    # --- Create Equipment ---
    for idx, equip in enumerate(equipment):
        try:
            equip_elem = create_equipment_element(f, subcontext, owner, lvl_lp, equip, idx)
            contained_elements.append(equip_elem)
        except Exception as e:
            print(f"Error creating equipment {idx}: {e}")

    # --- Create Ventilation ---
    try:
        vent_elems = create_ventilation_elements(f, subcontext, owner, lvl_lp, ventilation, length_m, width_m)
        contained_elements.extend(vent_elems)
    except Exception as e:
        print(f"Error creating ventilation: {e}")

    # --- Create Doors/Windows ---
    try:
        # Get south wall for default door (first wall in walls list)
        south_wall = walls[0] if walls else None

        if openings and len(openings) > 0:
            # Create openings from spec
            opening_elems = create_openings(f, subcontext, owner, lvl_lp, openings, length_m, width_m, height_m, walls)
            contained_elements.extend(opening_elems)
            print(f"Created {len(opening_elems)} openings from spec")
        else:
            # Add default door if no openings specified
            door, opening = create_default_door(f, subcontext, owner, lvl_lp, length_m, width_m, south_wall)
            contained_elements.append(door)
            contained_elements.append(opening)
    except Exception as e:
        print(f"Error creating openings: {e}")

    # --- Relate all elements to storey ---
    if contained_elements:
        f.create_entity(
            'IfcRelContainedInSpatialStructure',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            RelatedElements=tuple(contained_elements),
            RelatingStructure=storey
        )

    # Return STEP format as string
    return f.to_string()


# ============================================================================
# LAMBDA HANDLER
# ============================================================================

def handler(event, context):
    """Lambda handler for JSON to IFC4 conversion."""
    print(f"JsonToIFC input: {json.dumps(event)[:300]}")

    building_spec = event.get('buildingSpec')
    render_id = event.get('renderId')
    user_id = event.get('userId')

    if not building_spec:
        raise ValueError('No buildingSpec provided')

    try:
        ifc_content = generate_ifc4(building_spec)

        print('IFC4 generated successfully')
        print(f'IFC size: {len(ifc_content)} bytes')

        # Save IFC to S3 to avoid Step Function size limits
        bucket = 'builting-ifc'
        s3_key = f'{user_id}/{render_id}/model.ifc'

        try:
            s3_client.put_object(
                Bucket=bucket,
                Key=s3_key,
                Body=ifc_content.encode('utf-8'),
                ContentType='text/plain'
            )
            print(f'IFC saved to S3: s3://{bucket}/{s3_key}')
        except Exception as s3_error:
            print(f'Warning: Failed to save to S3: {s3_error}')
            # Continue anyway, don't fail the whole lambda

        return {
            'renderId': render_id,
            'userId': user_id,
            'ifcContent': ifc_content,
            'ifcGenerated': True,
            'ifcSizeBytes': len(ifc_content),
            'ifcS3Path': f's3://{bucket}/{s3_key}',
            'status': 'IFC generated and saved to S3'
        }
    except Exception as error:
        print(f'JsonToIFC error: {error}')
        raise
