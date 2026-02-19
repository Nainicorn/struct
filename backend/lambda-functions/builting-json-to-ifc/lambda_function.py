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
    """Generate valid IFC4 model from building specification with complete metadata."""

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

    # Create owner history (required by all entities)
    owner_history = create_owner_history(ifc_file)

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

    # Create unit assignment (required by project)
    unit_assignment = create_unit_assignment(ifc_file)

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

    # Create project with proper context and units
    project = ifc_file.create_entity(
        'IfcProject',
        Name=name,
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RepresentationContexts=[context],
        UnitsInContext=unit_assignment
    )

    # Create site
    site_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    site = ifc_file.create_entity(
        'IfcSite',
        Name='Site',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        ObjectPlacement=site_placement
    )

    # Aggregate site under project
    ifc_file.create_entity(
        'IfcRelAggregates',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatingObject=project,
        RelatedObjects=[site]
    )

    # Create building
    building_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    building = ifc_file.create_entity(
        'IfcBuilding',
        Name=name,
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        ObjectPlacement=building_placement,
        CompositionType='ELEMENT'
    )

    # Aggregate building under site
    ifc_file.create_entity(
        'IfcRelAggregates',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatingObject=site,
        RelatedObjects=[building]
    )

    # Create storey
    storey_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    storey = ifc_file.create_entity(
        'IfcBuildingStorey',
        Name='Ground Floor',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        ObjectPlacement=storey_placement,
        Elevation=floor_level,
        CompositionType='ELEMENT'
    )

    # Aggregate storey under building
    ifc_file.create_entity(
        'IfcRelAggregates',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatingObject=building,
        RelatedObjects=[storey]
    )

    # Create main structure element (tunnel/building envelope)
    main_structure = create_main_structure(
        ifc_file, placement, subcontext, width, height, length, owner_history
    )

    # Contain main structure in storey
    ifc_file.create_entity(
        'IfcRelContainedInSpatialStructure',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
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
                    i,
                    owner_history
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
                OwnerHistory=owner_history,
                RelatingStructure=storey,
                RelatedElements=room_elements
            )
            print(f"Added {len(room_elements)} rooms to storey")

    # Create ventilation/HVAC elements if provided
    if ventilation:
        try:
            vent_elements = create_ventilation_system(
                ifc_file, ventilation, placement, subcontext, owner_history
            )
            if vent_elements:
                ifc_file.create_entity(
                    'IfcRelContainedInSpatialStructure',
                    GlobalId=ifcopenshell.guid.new(),
                    OwnerHistory=owner_history,
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
                    ifc_file, equip_spec, placement, subcontext, i, owner_history
                )
                if equip:
                    ifc_file.create_entity(
                        'IfcRelContainedInSpatialStructure',
                        GlobalId=ifcopenshell.guid.new(),
                        OwnerHistory=owner_history,
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


def create_owner_history(ifc_file):
    """Create owner history entity required by all IFC entities."""
    org = ifc_file.create_entity(
        'IfcOrganization',
        Name='Building Generator'
    )
    app = ifc_file.create_entity(
        'IfcApplication',
        ApplicationDeveloper=org,
        Version='1.0',
        ApplicationFullName='IFC Building Generator',
        ApplicationIdentifier='BuildingGenerator'
    )
    person = ifc_file.create_entity(
        'IfcPerson',
        FamilyName='System'
    )
    person_org = ifc_file.create_entity(
        'IfcPersonAndOrganization',
        ThePerson=person,
        TheOrganization=org
    )
    owner_history = ifc_file.create_entity(
        'IfcOwnerHistory',
        OwningUser=person_org,
        OwningApplication=app,
        ChangeAction='ADDED',
        CreationDate=int(datetime.now().timestamp())
    )
    return owner_history


def create_unit_assignment(ifc_file):
    """Create unit assignment entity for the project."""
    length_unit = ifc_file.create_entity(
        'IfcSIUnit',
        UnitType='LENGTHUNIT',
        Name='METRE'
    )
    area_unit = ifc_file.create_entity(
        'IfcSIUnit',
        UnitType='AREAUNIT',
        Name='SQUARE_METRE'
    )
    volume_unit = ifc_file.create_entity(
        'IfcSIUnit',
        UnitType='VOLUMEUNIT',
        Name='CUBIC_METRE'
    )
    plane_angle_unit = ifc_file.create_entity(
        'IfcSIUnit',
        UnitType='PLANEANGLEUNIT',
        Name='RADIAN'
    )
    unit_assignment = ifc_file.create_entity(
        'IfcUnitAssignment',
        Units=[length_unit, area_unit, volume_unit, plane_angle_unit]
    )
    return unit_assignment


def create_material_and_style(ifc_file, solid):
    """Create material definition and styling for a geometric solid."""
    # Create color (concrete gray)
    color = ifc_file.create_entity(
        'IfcColourRgb',
        Red=0.75,
        Green=0.75,
        Blue=0.75
    )

    # Create surface style rendering
    rendering = ifc_file.create_entity(
        'IfcSurfaceStyleRendering',
        SurfaceColour=color,
        Transparency=0.0,
        ReflectanceMethod='FLAT'
    )

    # Create surface style
    surface_style = ifc_file.create_entity(
        'IfcSurfaceStyle',
        Name='Concrete Gray',
        Side='BOTH',
        Styles=[rendering]
    )

    # Create presentation style assignment
    style_assign = ifc_file.create_entity(
        'IfcPresentationStyleAssignment',
        Styles=[surface_style]
    )

    # Apply to solid via styled item
    styled_item = ifc_file.create_entity(
        'IfcStyledItem',
        Item=solid,
        Styles=[style_assign]
    )

    return styled_item


def create_main_structure(ifc_file, placement, subcontext, width, height, length, owner_history):
    """Create main building structure (beam) representing tunnel or main space."""

    beam_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    beam = ifc_file.create_entity(
        'IfcBeam',
        Name='Main Structure',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
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
        ProfileType='AREA',
        XDim=float(width),
        YDim=float(height),
        Position=profile_placement
    )

    # Create extrusion direction
    extrusion_dir = ifc_file.create_entity('IfcDirection', DirectionRatios=[0.0, 0.0, 1.0])

    # Create origin placement for solid (separate from beam's object placement)
    origin = ifc_file.create_entity('IfcCartesianPoint', Coordinates=[0.0, 0.0, 0.0])
    z_axis = ifc_file.create_entity('IfcDirection', DirectionRatios=[0.0, 0.0, 1.0])
    x_axis = ifc_file.create_entity('IfcDirection', DirectionRatios=[1.0, 0.0, 0.0])
    solid_placement = ifc_file.create_entity(
        'IfcAxis2Placement3D',
        Location=origin,
        Axis=z_axis,
        RefDirection=x_axis
    )

    # Create extruded area solid
    solid = ifc_file.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=rect_profile,
        Position=solid_placement,
        ExtrudedDirection=extrusion_dir,
        Depth=float(length)
    )

    # Add material and styling to the solid
    create_material_and_style(ifc_file, solid)

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


def create_room(ifc_file, room_spec, placement, subcontext, index, owner_history):
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
        OwnerHistory=owner_history,
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
        ProfileType='AREA',
        XDim=float(room_width),
        YDim=float(room_length),
        Position=profile_placement
    )

    extrusion_dir = ifc_file.create_entity('IfcDirection', DirectionRatios=[0.0, 0.0, 1.0])

    # Create solid placement
    solid_origin = ifc_file.create_entity('IfcCartesianPoint', Coordinates=[0.0, 0.0, 0.0])
    solid_placement = ifc_file.create_entity(
        'IfcAxis2Placement3D',
        Location=solid_origin,
        Axis=z_axis,
        RefDirection=x_axis
    )

    solid = ifc_file.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=rect_profile,
        Position=solid_placement,
        ExtrudedDirection=extrusion_dir,
        Depth=float(room_height)
    )

    # Add material and styling
    create_material_and_style(ifc_file, solid)

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


def create_ventilation_system(ifc_file, ventilation_spec, placement, subcontext, owner_history):
    """Create ventilation/HVAC system elements using safe entity types."""

    elements = []

    # Create intake duct as building element proxy
    intake_location = ventilation_spec.get('intake_location', 'West')
    intake = ifc_file.create_entity(
        'IfcBuildingElementProxy',
        Name=f'Intake - {intake_location}',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement),
        ObjectType='HVAC_INTAKE'
    )
    elements.append(intake)

    # Create exhaust duct as building element proxy
    exhaust_location = ventilation_spec.get('exhaust_location', 'East')
    exhaust = ifc_file.create_entity(
        'IfcBuildingElementProxy',
        Name=f'Exhaust - {exhaust_location}',
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement),
        ObjectType='HVAC_EXHAUST'
    )
    elements.append(exhaust)

    # Create fan if system type specified
    system_type = ventilation_spec.get('system_type', '')
    if system_type:
        fan = ifc_file.create_entity(
            'IfcBuildingElementProxy',
            Name=f'HVAC System - {system_type}',
            GlobalId=ifcopenshell.guid.new(),
            OwnerHistory=owner_history,
            ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement),
            ObjectType='HVAC_FAN'
        )
        elements.append(fan)

    return elements if elements else None


def create_equipment(ifc_file, equipment_spec, placement, subcontext, index, owner_history):
    """Create equipment element (generator, pump, etc) using safe entity types."""

    equip_name = equipment_spec.get('name', f'Equipment_{index}')
    equip_type = equipment_spec.get('type', 'OTHER').upper()

    # Use BuildingElementProxy as safe fallback for all equipment types
    equipment = ifc_file.create_entity(
        'IfcBuildingElementProxy',
        Name=equip_name,
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        ObjectPlacement=ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement),
        ObjectType=equip_type
    )

    return equipment
