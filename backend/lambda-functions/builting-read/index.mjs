import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});
const RENDERS_TABLE = process.env.RENDERS_TABLE || 'builting-renders';

export const handler = async (event) => {
  console.log('ReadMetadata input:', event);
  const { userId, renderId, bucket } = event;

  try {
    // Get render record from DynamoDB
    const result = await dynamo.send(
      new GetCommand({
        TableName: RENDERS_TABLE,
        Key: { user_id: userId, render_id: renderId }
      })
    );

    if (!result.Item) {
      throw new Error(`Render not found: ${renderId}`);
    }

    const render = result.Item;
    console.log('Found render:', render);

    // List files in S3 to validate
    const s3Result = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `uploads/${userId}/${renderId}/`
      })
    );

    const files = (s3Result.Contents || [])
      .filter(obj => obj.Key !== `uploads/${userId}/${renderId}/`) // Skip prefix itself
      .map(obj => ({
        key: obj.Key,
        name: obj.Key.split('/').pop(),
        size: obj.Size
      }));

    console.log(`Found ${files.length} files in S3`);

    if (files.length === 0) {
      throw new Error('No files found in S3 for render');
    }

    return {
      ...event,
      render,
      files,
      description: render.description || ''
    };
  } catch (error) {
    console.error('ReadMetadata error:', error);
    throw error;
  }
};
