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

    // Phase 6: Ensure render_revision always has a default so Step Function
    // JsonPath references ($.metadata.render.render_revision) never fail
    if (render.render_revision === undefined || render.render_revision === null) {
      render.render_revision = 1;
    }
    // Ensure validationReportS3Key is always present (null is fine for JsonPath)
    if (render.validationReportS3Key === undefined) {
      render.validationReportS3Key = null;
    }

    console.log('Found render:', render);

    // Use s3_path from render record (handles refinements pointing to original render's files)
    const s3Prefix = render.s3_path
      ? render.s3_path.replace(`s3://${bucket}/`, '') + '/'
      : `uploads/${userId}/${renderId}/`;

    // List files in S3 to validate
    const s3Result = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: s3Prefix
      })
    );

    const files = (s3Result.Contents || [])
      .filter(obj => obj.Key !== s3Prefix) // Skip prefix itself
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
