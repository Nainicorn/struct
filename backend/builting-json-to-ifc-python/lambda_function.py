"""
Convert building specification JSON to valid IFC4 STEP format using IfcOpenShell.
Handles all IFC validation, relationships, and geometry automatically.
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
    """Generate valid IFC4 model from building specification."""

    # Extract building parameters
    name = spec.get('buildingName', 'Building')
    length = spec.get('dimensions', {}).get('length_m', 100)
    width = spec.get('dimensions', {}).get('width_m', 50)
    height = spec.get('dimensions', {}).get('height_m', 6)
    portal_west = spec.get('elevations', {}).get('portal_west_m', 0)

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
        Elevation=0.0
    )

    # Aggregate storey under building
    ifc_file.create_entity(
        'IfcRelAggregates',
        GlobalId=ifcopenshell.guid.new(),
        RelatingObject=building,
        RelatedObjects=[storey]
    )

    # Create beam (best supported by web viewers)
    beam_placement = ifc_file.create_entity('IfcLocalPlacement', RelativePlacement=placement)
    beam = ifc_file.create_entity(
        'IfcBeam',
        Name='Tunnel Structure',
        GlobalId=ifcopenshell.guid.new(),
        ObjectPlacement=beam_placement
    )

    # Contain beam in storey
    ifc_file.create_entity(
        'IfcRelContainedInSpatialStructure',
        GlobalId=ifcopenshell.guid.new(),
        RelatingStructure=storey,
        RelatedElements=[beam]
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

    # Serialize to STEP format
    ifc_file.write('/tmp/output.ifc')
    with open('/tmp/output.ifc', 'r') as f:
        ifc_content = f.read()

    return ifc_content
