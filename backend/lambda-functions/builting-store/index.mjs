import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const RENDERS_TABLE = process.env.RENDERS_TABLE || 'builting-renders';
const IFC_BUCKET = process.env.IFC_BUCKET || 'builting-ifc';

export const handler = async (event) => {
  console.log('StoreIFC input:', JSON.stringify(event, null, 2));
  const { userId, renderId, ifcS3Path, ai_generated_title, ai_generated_description, elementCounts, outputMode, cssHash } = event;

  try {
    // Handle failure mode — called by Step Function Catch to mark render as failed
    if (event.failureMode) {
      console.log('Recording render failure:', event.error);
      const errorMsg = typeof event.error === 'object'
        ? (event.error.Cause || event.error.Error || JSON.stringify(event.error))
        : String(event.error || 'Unknown error');

      await dynamo.send(
        new UpdateCommand({
          TableName: RENDERS_TABLE,
          Key: { user_id: userId, render_id: renderId },
          UpdateExpression: 'SET #status = :status, error_message = :err',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'failed', ':err': errorMsg.substring(0, 1000) }
        })
      );
      console.log('DynamoDB updated with failed status');
      return { userId, renderId, status: 'failed', error_message: errorMsg };
    }

    // IFC is already saved to S3 by the IFC generator Lambda.
    // This Lambda updates DynamoDB with the path and metadata.
    const ifc_s3_path = ifcS3Path || `s3://${IFC_BUCKET}/${userId}/${renderId}/model.ifc`;

    console.log(`Recording IFC path: ${ifc_s3_path}`);

    // Build update expression dynamically
    let updateExpr = 'SET ifc_s3_path = :path, #status = :status';
    const exprValues = {
      ':path': ifc_s3_path,
      ':status': 'completed'
    };
    const exprNames = { '#status': 'status' };

    if (ai_generated_title) {
      updateExpr += ', ai_generated_title = :title';
      exprValues[':title'] = ai_generated_title;
    }

    if (ai_generated_description) {
      updateExpr += ', ai_generated_description = :desc';
      exprValues[':desc'] = ai_generated_description;
    }

    if (elementCounts) {
      updateExpr += ', elementCounts = :counts';
      exprValues[':counts'] = elementCounts;
    }

    if (outputMode) {
      updateExpr += ', outputMode = :mode';
      exprValues[':mode'] = outputMode;
    }

    if (cssHash) {
      updateExpr += ', cssHash = :hash';
      exprValues[':hash'] = cssHash;
    }

    await dynamo.send(
      new UpdateCommand({
        TableName: RENDERS_TABLE,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues
      })
    );

    console.log('DynamoDB updated with IFC path and metadata');

    return {
      ...event,
      ifc_s3_path
    };
  } catch (error) {
    console.error('StoreIFC error:', error);
    throw error;
  }
};
