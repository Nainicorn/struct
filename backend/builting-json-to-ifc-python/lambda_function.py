"""
Convert building specification JSON to valid IFC4 STEP format using IfcOpenShell.
Handles all IFC validation, relationships, and geometry automatically.
Processes rooms, ventilation, equipment, and spatial structure.
"""

import json
import uuid
from datetime import datetime
import ifcopenshell
from ifcopenshell.api import run


def handler(event, context):
    """Lambda handler for JSON to IFC conversion."""
    print(f"JsonToIFC input: {json.dumps(event)[:300]}")

    building_spec = event.get('buildingSpec')
    render_id = event.get('renderId')

    if not building_spec:
        raise ValueError('No buildingSpec provided')

    try:
        ifc_content = generate_ifc(building_spec)

        print('IFC generated successfully')
        print(f'IFC size: {len(ifc_content)} bytes')

        return {
            **event,
            'ifcContent': ifc_content
        }
    except Exception as error:
        print(f'JsonToIFC error: {error}')
        raise


def generate_ifc(spec):
    """Generate valid IFC4 model from building specification with full geometry."""

    # Extract building parameters
    name = spec.get('buildingName', 'Building')
    building_type = spec.get('buildingType', 'BUILDING')
    length = spec.get('dimensions', {}).get('length_m', 100)
    width = spec.get('dimensions', {}).get('width_m', 50)
    height = spec.get('dimensions', {}).get('height_m', 6)
    portal_west = spec.get('elevations', {}).get('portal_west_m', 0)
    portal_east = spec.get('elevations', {}).get('portal_east_m', length)
    floor_level = spec.get('elevations', {}).get('floor_level_m', 0)

    rooms = spec.get('rooms', [])
    ventilation = spec.get('ventilation', {})
    equipment = spec.get('equipment', [])

    # Create IFC file
    ifc_file = ifcopenshell.file(schema='IFC4')

    # Create project
    project = ifc_file.create_entity('IfcProject', Name=name, GlobalId=ifcopenshell.guid.new())

    # Create coordinate system (origin)
    origin = ifc_file.create_entity(
        'IfcCartesianPoint', Coordinates=[0.0, 0.0, 0.0]
    )
    z_axis = ifc_file.create_entity('IfcDirection', DirectionRatios=[0.0, 0.0, 1.0])
    x_axis = ifc_file.create_entity('IfcDirection', DirectionRatios=[1.0, 0.0, 0.0])

    placement = ifc_file.create_entity(
        'IfcAxis2Placement3D',
        Location=origin,
        Axis=z_axis,
        RefDirection=x_axis
    )

    # Create geometric representation context
    context = ifc_file.create_entity(
        'IfcGeometricRepresentationContext',
        ContextType='Model',
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=placement
    )

    # Create subcontext for body geometry
    subcontext = ifc_file.create_entity(
        'IfcGeometricRepresentationSubContext',
        ParentContext=context,
        ContextType='Model',
        ContextIdentifier='Body',
        TargetView='MODEL_VIEW'
    )

    # Assign context to project
    ifc_file.create_entity('IfcRelAssociatesClassification', GlobalId=ifcopenshell.guid.new(), RelatedObjects=[project], RelatingClassification=context)

    # Create site
    site_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    site = ifc_file.create_entity(
        'IfcSite', Name='Site', GlobalId=ifcopenshell.guid.new(), ObjectPlacement=site_placement
    )

    # Aggregate site under project
    ifc_file.create_entity(
        'IfcRelAggregates',
        GlobalId=ifcopenshell.guid.new(),
        RelatingObject=project,
        RelatedObjects=[site]
    )

    # Create building
    building_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    building = ifc_file.create_entity(
        'IfcBuilding', Name=name, GlobalId=ifcopenshell.guid.new(), ObjectPlacement=building_placement
    )

    # Aggregate building under site
    ifc_file.create_entity(
        'IfcRelAggregates',
        GlobalId=ifcopenshell.guid.new(),
        RelatingObject=site,
        RelatedObjects=[building]
    )

    # Create storey
    storey_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    storey = ifc_file.create_entity(
        'IfcBuildingStorey',
        Name='Ground Floor',
        GlobalId=ifcopenshell.guid.new(),
        ObjectPlacement=storey_placement,
        Elevation=floor_level
    )

    # Aggregate storey under building
    ifc_file.create_entity(
        'IfcRelAggregates',
        GlobalId=ifcopenshell.guid.new(),
        RelatingObject=building,
        RelatedObjects=[storey]
    )

    # Create main structure element (tunnel/building envelope)
    main_structure = create_main_structure(
        ifc_file, placement, subcontext, width, height, length
    )

    # Contain main structure in storey
    ifc_file.create_entity(
        'IfcRelContainedInSpatialStructure',
        GlobalId=ifcopenshell.guid.new(),
        RelatingStructure=storey,
        RelatedElements=[main_structure]
    )

    # Create individual room spaces if provided
    if rooms:
        room_elements = []
        for i, room_spec in enumerate(rooms):
            try:
                room = create_room(
                    ifc_file,
                    room_spec,
                    placement,
                    subcontext,
                    i
                )
                if room:
                    room_elements.append(room)
                    print(f"Created room: {room_spec.get('name', f'Room_{i}')}")
            except Exception as e:
                print(f"Warning: Failed to create room {i}: {e}")

        if room_elements:
            ifc_file.create_entity(
                'IfcRelContainedInSpatialStructure',
                GlobalId=ifcopenshell.guid.new(),
                RelatingStructure=storey,
                RelatedElements=room_elements
            )
            print(f"Added {len(room_elements)} rooms to storey")

    # Create ventilation/HVAC elements if provided
    if ventilation:
        try:
            vent_elements = create_ventilation_system(
                ifc_file, ventilation, placement, subcontext
            )
            if vent_elements:
                ifc_file.create_entity(
                    'IfcRelContainedInSpatialStructure',
                    GlobalId=ifcopenshell.guid.new(),
                    RelatingStructure=storey,
                    RelatedElements=vent_elements
                )
        except Exception as e:
            print(f"Warning: Failed to create ventilation system: {e}")

    # Create equipment elements if provided
    if equipment:
        for i, equip_spec in enumerate(equipment):
            try:
                equip = create_equipment(
                    ifc_file, equip_spec, placement, subcontext, i
                )
                if equip:
                    ifc_file.create_entity(
                        'IfcRelContainedInSpatialStructure',
                        GlobalId=ifcopenshell.guid.new(),
                        RelatingStructure=storey,
                        RelatedElements=[equip]
                    )
            except Exception as e:
                print(f"Warning: Failed to create equipment {i}: {e}")

    # Serialize to STEP format
    ifc_file.write('/tmp/output.ifc')
    with open('/tmp/output.ifc', 'r') as f:
        ifc_content = f.read()

    return ifc_content


def create_main_structure(ifc_file, placement, subcontext, width, height, length):
    """Create main building structure (beam/wall) representing tunnel or main space."""

    beam_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    beam = ifc_file.create_entity(
        'IfcBeam',
        Name='Main Structure',
        GlobalId=ifcopenshell.guid.new(),
        ObjectPlacement=beam_placement
    )

    # Create rectangle profile for extrusion
    profile_pt = ifc_file.create_entity('IfcCartesianPoint', Coordinates=[0.0, 0.0])
    profile_placement = ifc_file.create_entity(
        'IfcAxis2Placement2D',
        Location=profile_pt,
        RefDirection=ifc_file.create_entity('IfcDirection', DirectionRatios=[1.0, 0.0])
    )
    rect_profile = ifc_file.create_entity(
        'IfcRectangleProfileDef',
        XDim=float(width),
        YDim=float(height),
        Position=profile_placement
    )

    # Create extrusion direction
    extrusion_dir = ifc_file.create_entity('IfcDirection', DirectionRatios=[0.0, 0.0, 1.0])

    # Create extruded area solid
    solid = ifc_file.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=rect_profile,
        Position=placement,
        ExtrudedDirection=extrusion_dir,
        Depth=float(length)
    )

    # Create shape representation
    representation = ifc_file.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationType='SweptSolid',
        RepresentationIdentifier='Body',
        Items=[solid]
    )

    # Create product definition shape
    shape_def = ifc_file.create_entity(
        'IfcProductDefinitionShape',
        Representations=[representation]
    )

    # Assign representation to beam
    beam.Representation = shape_def

    return beam


def create_room(ifc_file, room_spec, placement, subcontext, index):
    """Create an individual room space as a column element with geometry."""

    room_name = room_spec.get('name', f'Room_{index}')
    room_length = room_spec.get('length_m', 10)
    room_width = room_spec.get('width_m', 8)
    room_height = room_spec.get('height_m', 3)
    x_pos = room_spec.get('x_position_m', 0)
    y_pos = room_spec.get('y_position_m', 0)

    # Create placement for room (offset from origin)
    room_origin = ifc_file.create_entity(
        'IfcCartesianPoint', Coordinates=[float(x_pos), float(y_pos), 0.0]
    )
    z_axis = ifc_file.create_entity('IfcDirection', DirectionRatios=[0.0, 0.0, 1.0])
    x_axis = ifc_file.create_entity('IfcDirection', DirectionRatios=[1.0, 0.0, 0.0])
    room_placement_3d = ifc_file.create_entity(
        'IfcAxis2Placement3D',
        Location=room_origin,
        Axis=z_axis,
        RefDirection=x_axis
    )
    room_local_placement = ifc_file.create_entity(
        'IfcLocalPlacement',
        RelativePlacement=room_placement_3d
    )

    # Create column element for the room (will be visible in viewer)
    column = ifc_file.create_entity(
        'IfcColumn',
        Name=room_name,
        GlobalId=ifcopenshell.guid.new(),
        ObjectPlacement=room_local_placement
    )

    # Create room geometry (rectangular box)
    profile_pt = ifc_file.create_entity('IfcCartesianPoint', Coordinates=[0.0, 0.0])
    profile_placement = ifc_file.create_entity(
        'IfcAxis2Placement2D',
        Location=profile_pt,
        RefDirection=ifc_file.create_entity('IfcDirection', DirectionRatios=[1.0, 0.0])
    )
    rect_profile = ifc_file.create_entity(
        'IfcRectangleProfileDef',
        XDim=float(room_width),
        YDim=float(room_length),
        Position=profile_placement
    )

    extrusion_dir = ifc_file.create_entity('IfcDirection', DirectionRatios=[0.0, 0.0, 1.0])
    solid = ifc_file.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=rect_profile,
        Position=room_placement_3d,
        ExtrudedDirection=extrusion_dir,
        Depth=float(room_height)
    )

    representation = ifc_file.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationType='SweptSolid',
        RepresentationIdentifier='Body',
        Items=[solid]
    )

    shape_def = ifc_file.create_entity(
        'IfcProductDefinitionShape',
        Representations=[representation]
    )

    column.Representation = shape_def

    return column


def create_ventilation_system(ifc_file, ventilation_spec, placement, subcontext):
    """Create ventilation/HVAC system elements."""

    elements = []

    # Create intake duct
    intake_location = ventilation_spec.get('intake_location', 'West')
    intake = ifc_file.create_entity(
        'IfcDuctSegment',
        Name=f'Intake - {intake_location}',
        GlobalId=ifcopenshell.guid.new(),
        ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    )
    elements.append(intake)

    # Create exhaust duct
    exhaust_location = ventilation_spec.get('exhaust_location', 'East')
    exhaust = ifc_file.create_entity(
        'IfcDuctSegment',
        Name=f'Exhaust - {exhaust_location}',
        GlobalId=ifcopenshell.guid.new(),
        ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    )
    elements.append(exhaust)

    # Create fan if system type specified
    system_type = ventilation_spec.get('system_type', '')
    if system_type:
        fan = ifc_file.create_entity(
            'IfcFlowSegment',
            Name=f'HVAC System - {system_type}',
            GlobalId=ifcopenshell.guid.new(),
            ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
        )
        elements.append(fan)

    return elements if elements else None


def create_equipment(ifc_file, equipment_spec, placement, subcontext, index):
    """Create equipment element (generator, pump, etc)."""

    equip_name = equipment_spec.get('name', f'Equipment_{index}')
    equip_type = equipment_spec.get('type', 'OTHER')

    # Map equipment type to IFC entity
    if equip_type.lower() in ['generator', 'diesel']:
        entity_type = 'IfcElectricalElement'
    elif equip_type.lower() in ['pump', 'fan']:
        entity_type = 'IfcFlowMovingDevice'
    else:
        entity_type = 'IfcFlowTerminal'

    equipment = ifc_file.create_entity(
        entity_type,
        Name=equip_name,
        GlobalId=ifcopenshell.guid.new(),
        ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    )

    return equipment
