"""
Generate IFC2X3 using IfcOpenShell for Revit + web viewer compatibility.
Uses proper IFC GUIDs and correct entity structure.
Converts building specification JSON to complete IFC model.
"""

import json
from datetime import datetime, timezone

try:
    import ifcopenshell
    import ifcopenshell.guid
except Exception as e:
    raise RuntimeError(f"IfcOpenShell not available in runtime: {e}")


def new_guid():
    """Generate proper IFC GUID (22-char compressed)."""
    return ifcopenshell.guid.new()


def handler(event, context):
    """Lambda handler for JSON to IFC conversion."""
    print(f"JsonToIFC input: {json.dumps(event)[:300]}")

    building_spec = event.get('buildingSpec')
    render_id = event.get('renderId')

    if not building_spec:
        raise ValueError('No buildingSpec provided')

    try:
        ifc_content = generate_ifc2x3(building_spec)

        print('IFC generated successfully')
        print(f'IFC size: {len(ifc_content)} bytes')

        return {
            **event,
            'ifcContent': ifc_content
        }
    except Exception as error:
        print(f'JsonToIFC error: {error}')
        raise


def generate_ifc2x3(spec):
    """Generate IFC2X3 file using IfcOpenShell with full building specification."""

    name = spec.get('buildingName', 'Building')
    building_type = spec.get('buildingType', 'BUILDING')
    ts = int(datetime.now(timezone.utc).timestamp())

    # Extract dimensions and elevations
    dims = spec.get('dimensions', {})
    length_m = float(dims.get('length_m', 100.0))
    width_m = float(dims.get('width_m', 50.0))
    height_m = float(dims.get('height_m', 6.0))

    elevations = spec.get('elevations', {})
    floor_level_m = float(elevations.get('floor_level_m', 0.0))

    rooms = spec.get('rooms', [])
    equipment = spec.get('equipment', [])
    ventilation = spec.get('ventilation', {})

    # Create IFC2X3 file
    f = ifcopenshell.file(schema='IFC2X3')

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

    # --- Create Building Envelope (main structure) ---
    envelope_elem = create_building_envelope(f, subcontext, owner, lvl_lp, length_m, width_m, height_m)

    contained_elements = [envelope_elem]

    # --- Create Rooms ---
    for idx, room in enumerate(rooms):
        try:
            room_elem = create_room(f, subcontext, owner, lvl_lp, room, idx)
            if room_elem:
                contained_elements.append(room_elem)
        except Exception as e:
            print(f"Error creating room {idx}: {e}")

    # --- Create Equipment ---
    for idx, equip in enumerate(equipment):
        try:
            equip_elem = create_equipment(f, subcontext, owner, lvl_lp, equip, idx)
            if equip_elem:
                contained_elements.append(equip_elem)
        except Exception as e:
            print(f"Error creating equipment {idx}: {e}")

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


def create_building_envelope(f, subcontext, owner, lvl_lp, length_m, width_m, height_m):
    """Create the main building envelope structure."""
    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))

    # Create rectangular profile for building footprint
    prof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
    prof_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
    prof_place = f.create_entity('IfcAxis2Placement2D', Location=prof_origin, RefDirection=prof_x)
    profile = f.create_entity('IfcRectangleProfileDef',
                             ProfileType='AREA',
                             XDim=length_m,
                             YDim=width_m,
                             Position=prof_place)

    extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    solid_pos = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)

    solid = f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile,
        Position=solid_pos,
        ExtrudedDirection=extrude_dir,
        Depth=height_m
    )

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='SweptSolid',
        Items=(solid,),
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))

    elem_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=lvl_lp, RelativePlacement=solid_pos)
    elem = f.create_entity(
        'IfcBuilding',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='BuildingEnvelope',
        ObjectPlacement=elem_lp,
        Representation=pds
    )

    return elem


def create_room(f, subcontext, owner, lvl_lp, room_data, idx):
    """Create a room element from room data."""
    name = room_data.get('name', f'Room {idx}')
    length = float(room_data.get('length_m', 10.0))
    width = float(room_data.get('width_m', 8.0))
    height = float(room_data.get('height_m', 3.0))
    x_pos = float(room_data.get('x_position_m', 0.0))
    y_pos = float(room_data.get('y_position_m', 0.0))

    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))

    # Create rectangular profile
    prof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
    prof_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
    prof_place = f.create_entity('IfcAxis2Placement2D', Location=prof_origin, RefDirection=prof_x)
    profile = f.create_entity('IfcRectangleProfileDef',
                             ProfileType='AREA',
                             XDim=length,
                             YDim=width,
                             Position=prof_place)

    extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    solid_pos = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)

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
        Items=(solid,),
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))

    # Position room at x, y location
    placement_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_pos, y_pos, 0.0))
    room_placement = f.create_entity('IfcAxis2Placement3D', Location=placement_origin, Axis=axis, RefDirection=refd)
    elem_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=lvl_lp, RelativePlacement=room_placement)

    elem = f.create_entity(
        'IfcSpace',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectPlacement=elem_lp,
        Representation=pds
    )

    return elem


def create_equipment(f, subcontext, owner, lvl_lp, equipment_data, idx):
    """Create an equipment element from equipment data."""
    name = equipment_data.get('name', f'Equipment {idx}')
    equip_type = equipment_data.get('type', 'EQUIPMENT')
    x_pos = float(equipment_data.get('x_position_m', 0.0))
    y_pos = float(equipment_data.get('y_position_m', 0.0))

    # Equipment size varies by type (default 1m × 1m × 1m)
    size_map = {
        'GENERATOR': (2.0, 1.5, 1.5),
        'PUMP': (1.0, 0.8, 1.0),
        'FAN': (1.5, 1.0, 0.5),
        'COMPRESSOR': (1.5, 1.0, 1.5),
        'TRANSFORMER': (2.0, 1.5, 2.0),
        'BATTERY': (1.0, 0.8, 0.8),
        'CONVERTER': (1.0, 0.6, 1.0),
    }
    length, width, height = size_map.get(equip_type, (1.0, 1.0, 1.0))

    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))

    # Create rectangular profile for equipment
    prof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
    prof_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
    prof_place = f.create_entity('IfcAxis2Placement2D', Location=prof_origin, RefDirection=prof_x)
    profile = f.create_entity('IfcRectangleProfileDef',
                             ProfileType='AREA',
                             XDim=length,
                             YDim=width,
                             Position=prof_place)

    extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    solid_pos = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)

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
        Items=(solid,),
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))

    # Position equipment at x, y location
    placement_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_pos, y_pos, 0.0))
    equip_placement = f.create_entity('IfcAxis2Placement3D', Location=placement_origin, Axis=axis, RefDirection=refd)
    elem_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=lvl_lp, RelativePlacement=equip_placement)

    elem = f.create_entity(
        'IfcBuildingElementProxy',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectType=equip_type,
        ObjectPlacement=elem_lp,
        Representation=pds
    )

    return elem
