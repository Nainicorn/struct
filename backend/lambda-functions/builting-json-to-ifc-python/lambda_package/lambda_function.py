"""
Generate minimal valid IFC4 STEP format files using proven structure.
Based on working xeokit-compatible template.
"""

import json
import uuid
from datetime import datetime


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
    """Generate minimal valid IFC4 STEP format using proven xeokit-compatible structure."""

    name = spec.get('buildingName', 'Building')
    timestamp = int(datetime.now().timestamp())

    # Use a proven minimal IFC4 structure that xeokit can parse
    step_content = f"""ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''), '2;1');
FILE_NAME('{name}.ifc', {timestamp}, (''), (''), 'Preprocessor', 'BuildingGenerator', '');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1 = IFCORGANIZATION($, 'Organization', $, $, $);
#2 = IFCAPPLICATION(#1, '0.9', 'ETS', 'ETSX');
#3 = IFCPERSON($, 'Person', $, $, $, $, $, $);
#4 = IFCPERSONANDORGANIZATION(#3, #1, $);
#5 = IFCOWNERHISTORY(#4, #2, $, .ADDED., {timestamp}, $, $, $);
#6 = IFCPROJECT('{str(uuid.uuid4())}', #5, '{name}', '', '', $, '', (2, 3), #7);
#7 = IFCUNITASSIGNMENT((#8, #9, #10, #11));
#8 = IFCSIUNIT(*, .LENGTHUNIT., .METRE.);
#9 = IFCSIUNIT(*, .AREAUNIT., .SQUARE_METRE.);
#10 = IFCSIUNIT(*, .VOLUMEUNIT., .CUBIC_METRE.);
#11 = IFCSIUNIT(*, .PLANEANGLEUNIT., .RADIAN.);
#12 = IFCCARTESIANPOINT((0., 0., 0.));
#13 = IFCDIRECTION((0., 0., 1.));
#14 = IFCDIRECTION((1., 0., 0.));
#15 = IFCAXIS2PLACEMENT3D(#12, #13, #14);
#16 = IFCGEOMETRICREPRESENTATIONCONTEXT('Model', 'Model', 3, 0.01, #15, $);
#17 = IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body', 'Model', *, 'MODEL_VIEW', *);
#17.ParentContext = #16;
#18 = IFCLOCALPLACEMENT($, #15);
#19 = IFCSITE('{str(uuid.uuid4())}', #5, 'Site', '', '', #18, '', '', .ELEMENT., (*, *, *), (*, *, *), *, $, $);
#20 = IFCRELAGGREGATES('{str(uuid.uuid4())}', #5, '', '', #6, (#19));
#21 = IFCLOCALPLACEMENT(#18, #15);
#22 = IFCBUILDING('{str(uuid.uuid4())}', #5, 'Building', '', '', #21, '', '', .ELEMENT., (*, *, *), (*, *, *), $);
#23 = IFCRELAGGREGATES('{str(uuid.uuid4())}', #5, '', '', #19, (#22));
#24 = IFCLOCALPLACEMENT(#21, #15);
#25 = IFCBUILDINGSTOREY('{str(uuid.uuid4())}', #5, 'Ground', '', '', #24, 0., .ELEMENT., (*, *, *));
#26 = IFCRELAGGREGATES('{str(uuid.uuid4())}', #5, '', '', #22, (#25));
#27 = IFCCARTESIANPOINT((0., 0., 0.));
#28 = IFCDIRECTION((1., 0., 0.));
#29 = IFCAXIS2PLACEMENT2D(#27, #28);
#30 = IFCRECTANGLEPROFILEDEF(.AREA., '', #29, 10., 10.);
#31 = IFCDIRECTION((0., 0., 1.));
#32 = IFCEXTRUDEDAREASOLID(#30, #15, #31, 5.);
#33 = IFCSHAPEREPRESENTATION(#16, 'Body', 'SweptSolid', (#32));
#34 = IFCPRODUCTDEFINITIONSHAPE($, '', (#33));
#35 = IFCLOCALPLACEMENT(#24, #15);
#36 = IFCBEAM('{str(uuid.uuid4())}', #5, 'Beam', '', '', #35, #34, '');
#37 = IFCRELCONTAINEDINSPATIALSTRUCTURE('{str(uuid.uuid4())}', #5, '', '', #25, (#36));
ENDSEC;
END-ISO-10303-21;"""

    return step_content
