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

    // Call Bedrock API (Claude 3.5 Sonnet)
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 100000,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        })
      })
    );

    const modelResponse = JSON.parse(
      new TextDecoder().decode(response.body)
    );
    const ifcContent = modelResponse.content[0].text;

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
