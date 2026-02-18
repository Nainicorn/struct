import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({ region: 'us-east-1' });
const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

export const handler = async (event) => {
  console.log('StoreIFC input:', event);
  const { userId, renderId, ifcContent, ai_generated_title, ai_generated_description } = event;

  try {
    const ifc_s3_path = `s3://builting-ifc/${userId}/${renderId}/output.ifc`;
    const s3Key = `${userId}/${renderId}/output.ifc`;

    console.log(`Storing IFC to s3://builting-ifc/${s3Key}`);

    // Upload IFC file to builting-ifc bucket
    // Convert string content to Buffer for proper binary storage
    const ifcBuffer = Buffer.from(ifcContent, 'utf-8');
    await s3.send(
      new PutObjectCommand({
        Bucket: 'builting-ifc',
        Key: s3Key,
        Body: ifcBuffer,
        ContentType: 'application/octet-stream'
      })
    );

    console.log('IFC file uploaded successfully');

    // Store IFC path in DynamoDB for quick access
    await dynamo.send(
      new UpdateCommand({
        TableName: 'builting-renders',
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: 'SET ifc_s3_path = :path, ai_generated_title = :title, ai_generated_description = :desc',
        ExpressionAttributeValues: {
          ':path': ifc_s3_path,
          ':title': ai_generated_title,
          ':desc': ai_generated_description
        }
      })
    );

    console.log('DynamoDB updated with IFC path');

    return {
      ...event,
      ifc_s3_path
    };
  } catch (error) {
    console.error('StoreIFC error:', error);
    throw error;
  }
};
