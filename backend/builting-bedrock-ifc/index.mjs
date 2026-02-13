import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const s3 = new S3Client({ region: 'us-east-1' });

export const handler = async (event) => {
  console.log('BedrockInvokeIFC input:', event);
  const { userId, renderId, bucket, files, description } = event;

  try {
    // Download description if available
    let descriptionContent = description || '';
    const descFile = files.find(f => f.name === 'description.txt');
    if (descFile) {
      try {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: descFile.key
          })
        );
        descriptionContent = await response.Body.transformToString();
      } catch (err) {
        console.log('Could not read description.txt from S3:', err.message);
      }
    }

    // Build Bedrock prompt
    const fileList = files
      .filter(f => f.name !== 'description.txt')
      .map(f => `- ${f.name} (${f.size} bytes)`)
      .join('\n');

    const prompt = `Generate a valid IFC (Industry Foundation Classes) file based on the following description and files.

Description:
${descriptionContent || '(No description provided)'}

Files provided:
${fileList || '(No files)'}

Create a comprehensive IFC file with proper structure, including:
1. IfcProject and IfcSite
2. IfcBuilding with proper geometry
3. Walls, floors, roofs, and doors/windows
4. Proper relationships and hierarchy

Return the complete IFC file content in valid IFC format.`;

    console.log('Calling Bedrock with prompt...');

    // For testing: return dummy IFC content instead of calling Bedrock
    // TODO: Remove this and use actual Bedrock call once timeout issues are resolved
    const ifcContent = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test IFC Model'));
FILE_NAME('render-${renderId}.ifc');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1 = IFCPROJECT('${renderId}', #2, 'Test Render', 'Test Project', $, $, $, (#3), #4);
#2 = IFCOWNERHISTORY($, $, $, $, $, $, $, 0);
#3 = IFCGEOMETRICREPRESENTATIONCONTEXT($, 'Model', 3, 1.E-05, #5, #6);
#4 = IFCUNITASSIGNMENT((#7, #8, #9));
#5 = IFCAXIS2PLACEMENT3D(#10, #11, #12);
#6 = IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body', 'Model', *, *, *, *, #3, *, .MODEL_VIEW., *);
#7 = IFCSIUNIT(*, .LENGTHUNIT., $, .METRE.);
#8 = IFCSIUNIT(*, .PLANEANGLEUNIT., $, .RADIAN.);
#9 = IFCSIUNIT(*, .SOLIDANGLEUNIT., $, .STERADIAN.);
#10 = IFCCARTESIANPOINT((0., 0., 0.));
#11 = IFCDIRECTION((0., 0., 1.));
#12 = IFCDIRECTION((1., 0., 0.));
ENDSEC;
END-ISO-10303-21;`;

    console.log('IFC content generated (test mode)');

    // Extract metadata from response
    const ai_generated_title = `Render ${renderId.slice(0, 8)}`;
    const ai_generated_description = `IFC model generated from ${files.length} source files`;

    console.log('IFC generation complete, returning to Step Function');

    return {
      ...event,
      ifcContent,
      ai_generated_title,
      ai_generated_description
    };
  } catch (error) {
    console.error('BedrockInvokeIFC error:', error);
    throw error;
  }
};
