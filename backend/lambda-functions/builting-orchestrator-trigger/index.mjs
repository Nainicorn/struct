import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const sfn = new SFNClient({ region: 'us-east-1' });
const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

export const handler = async (event) => {
  console.log('Orchestrator trigger received:', JSON.stringify(event, null, 2));

  try {
    // Process SNS message containing S3 events
    for (const record of event.Records || []) {
      const message = JSON.parse(record.Sns.Message);
      console.log('S3 event message:', message);

      // Process each S3 record
      for (const s3Record of message.Records || []) {
        const bucket = s3Record.s3.bucket.name;
        const key = s3Record.s3.object.key;

        console.log(`Processing S3 event: ${bucket}/${key}`);

        // Parse userId and renderId from path: uploads/userId/renderId/filename
        const parts = key.split('/');
        if (parts[0] !== 'uploads' || parts.length < 4) {
          console.log('Skipping non-upload file or invalid path:', key);
          continue;
        }

        const userId = parts[1];
        const renderId = parts[2];

        console.log(`Trigger for userId=${userId}, renderId=${renderId}`);

        // Check if upload has been finalized — if not, skip and let the finalize endpoint handle it
        try {
          const renderResult = await dynamo.send(new GetCommand({
            TableName: 'builting-renders',
            Key: { user_id: userId, render_id: renderId }
          }));
          if (renderResult.Item && !renderResult.Item.upload_finalized) {
            console.log(`Render ${renderId} not yet finalized, skipping SNS trigger (finalize endpoint will start pipeline)`);
            continue;
          }
        } catch (checkErr) {
          console.warn('Could not check finalized flag, proceeding with legacy behavior:', checkErr.message);
        }

        // DEDUPLICATION: Set orchestration_started flag atomically
        try {
          await dynamo.send(
            new UpdateCommand({
              TableName: 'builting-renders',
              Key: { user_id: userId, render_id: renderId },
              UpdateExpression: 'SET orchestration_started = :true',
              ConditionExpression: 'attribute_not_exists(orchestration_started)',
              ExpressionAttributeValues: { ':true': true }
            })
          );
          console.log(`Deduplication flag set for ${renderId}`);
        } catch (err) {
          if (err.name === 'ConditionalCheckFailedException') {
            console.log(`Already started orchestration for ${renderId}, skipping`);
            continue;
          }
          throw err;
        }

        // Invoke Step Function
        const stateMachineArn = process.env.STATE_MACHINE_ARN;
        if (!stateMachineArn) {
          throw new Error('STATE_MACHINE_ARN environment variable not set');
        }

        console.log(`Starting execution on ${stateMachineArn}`);

        const executionResult = await sfn.send(
          new StartExecutionCommand({
            stateMachineArn,
            input: JSON.stringify({
              userId,
              renderId,
              bucket
            }),
            name: `render-${renderId}-${Date.now()}`
          })
        );

        console.log(`Step Function execution started: ${executionResult.executionArn}`);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Orchestration triggered' })
    };
  } catch (error) {
    console.error('Orchestrator error:', error);
    throw error;
  }
};
