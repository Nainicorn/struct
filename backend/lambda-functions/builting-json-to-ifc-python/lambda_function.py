"""
Generate IFC4 using IfcOpenShell with rich architectural detail.
Supports multiple building types (office, warehouse, tunnel, parking, industrial, etc.)
with proper materials, property sets, element types, and spatial hierarchy.
"""

import json
from datetime import datetime, timezone

try:
    import ifcopenshell
    import ifcopenshell.guid
except Exception as e:
    raise RuntimeError(f"IfcOpenShell not available in runtime: {e}")


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

def create_building_walls(f, subcontext, owner, parent_lp, length_m, width_m, height_m, wall_thickness_m):
    """Create 4 exterior walls (N, S, E, W) as separate IfcWall entities."""
    walls = []
    mat_color = MATERIAL_COLORS.get('concrete', (0.75, 0.75, 0.75))

    # Helper to create one wall
    def make_wall(name, x_pos, y_pos, w_length, w_width, w_height):
        solid, _, pds = create_rectangular_solid(f, w_length, w_width, w_height, None, subcontext, owner)
        apply_style(f, solid, mat_color, transparency=0.0, entity_name=name)

        wall_origin = f.create_entity('IfcCartesianPoint', Coordinates=(x_pos, y_pos, 0.0))
        axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
        refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
        wall_place = f.create_entity('IfcAxis2Placement3D', Location=wall_origin, Axis=axis, RefDirection=refd)
        wall_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=wall_place)

        wall = f.create_entity(
            'IfcWall',
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

    return elem


# ============================================================================
# VENTILATION
# ============================================================================

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

def create_default_door(f, subcontext, owner, parent_lp, length_m, width_m):
    """Create a default door on the south wall."""
    solid, _, pds = create_rectangular_solid(f, 1.0, 0.1, 2.1, None, subcontext, owner)
    apply_style(f, solid, MATERIAL_COLORS['door'], transparency=0.0, entity_name='Main Door')

    door_origin = f.create_entity('IfcCartesianPoint', Coordinates=(length_m / 2 - 0.5, 0.0, 0.0))
    axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    door_place = f.create_entity('IfcAxis2Placement3D', Location=door_origin, Axis=axis, RefDirection=refd)
    door_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=door_place)

    door = f.create_entity(
        'IfcDoor',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        Name='Main Door',
        ObjectPlacement=door_lp,
        Representation=pds,
        PredefinedType='SWINGDOOR'
    )

    add_property_set(f, owner, door, 'Pset_DoorCommon', {
        'IsExternal': (True, 'IfcBoolean'),
        'FireExit': (False, 'IfcBoolean'),
    })

    return door


# ============================================================================
# MAIN IFC4 GENERATOR
# ============================================================================

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

    # Create walls
    walls = create_building_walls(f, subcontext, owner, lvl_lp, length_m, width_m, height_m, wall_thickness_m)
    contained_elements.extend(walls)

    # Create floor
    floor = create_floor_slab(f, subcontext, owner, lvl_lp, length_m, width_m)
    contained_elements.append(floor)

    # Create roof
    roof = create_roof_slab(f, subcontext, owner, lvl_lp, length_m, width_m, height_m)
    contained_elements.append(roof)

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
        # Add default door if no openings specified
        if not openings or len(openings) == 0:
            door = create_default_door(f, subcontext, owner, lvl_lp, length_m, width_m)
            contained_elements.append(door)
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

    if not building_spec:
        raise ValueError('No buildingSpec provided')

    try:
        ifc_content = generate_ifc4(building_spec)

        print('IFC4 generated successfully')
        print(f'IFC size: {len(ifc_content)} bytes')

        return {
            **event,
            'ifcContent': ifc_content
        }
    except Exception as error:
        print(f'JsonToIFC error: {error}')
        raise
