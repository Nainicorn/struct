import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({ region: 'us-east-1' });
const sfn = new SFNClient({ region: 'us-east-1' });

const TableName = 'builting-renders';

const renders = {
  handle: async (event) => {
    const userId = event.queryStringParameters?.userId;
    if (!userId) return { error: 'Auth required', statusCode: 401 };

    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const path = event.path || event.rawPath || '';

    try {
      // POST /api/renders/{renderId}/finalize - finalize upload and start pipeline
      if (method === 'POST' && path.includes('/finalize')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.finalizeRender(userId, renderId);
      }

      // GET /api/renders - list all renders for user
      if (method === 'GET' && !path.includes('/download')) {
        const renderId = path.split('/').pop();
        if (renderId && renderId !== 'renders' && renderId !== 'api') {
          return await renders.getRender(userId, renderId);
        }
        return await renders.listRenders(userId);
      }

      // GET /api/renders/{renderId}/download - download URL
      if (method === 'GET' && path.includes('/download')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.getDownloadUrl(userId, renderId);
      }

      // DELETE /api/renders/{renderId}
      if (method === 'DELETE') {
        const renderId = path.split('/').pop();
        return await renders.deleteRender(userId, renderId);
      }

      return { error: 'Method not allowed', statusCode: 405 };
    } catch (error) {
      console.error('Renders error:', error);
      return { error: error.message, statusCode: 500 };
    }
  },

  createRender: async (userId, renderId, description, fileNames) => {
    console.log('Creating render:', { userId, renderId, description, fileNames });
    const item = {
      user_id: userId,
      render_id: renderId,
      status: 'pending',
      created_at: Math.floor(Date.now() / 1000),
      source_files: fileNames,
      s3_path: `s3://builting-data/uploads/${userId}/${renderId}`,
      description: description || ''
    };

    await dynamo.send(new PutCommand({ TableName, Item: item }));
    return item;
  },

  getRender: async (userId, renderId) => {
    const result = await dynamo.send(
      new GetCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId }
      })
    );

    if (!result.Item) return { error: 'Render not found', statusCode: 404 };
    return result.Item;
  },

  listRenders: async (userId) => {
    const result = await dynamo.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'user_id = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false
      })
    );

    return { renders: result.Items || [] };
  },

  updateStatus: async (userId, renderId, status, updates = {}) => {
    const updateExpr = ['#status = :status', ...Object.keys(updates).map(k => `${k} = :${k}`)];
    const exprValues = { ':status': status, ...Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v])) };

    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: updateExpr.join(', '),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: exprValues
      })
    );
  },

  getDownloadUrl: async (userId, renderId) => {
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    if (render.status !== 'completed') {
      return { error: `Render is ${render.status}, not ready for download`, statusCode: 400 };
    }

    // Fetch file from S3 and return as base64
    const key = `${render.ifc_s3_path.replace('s3://builting-ifc/', '')}`;
    const response = await s3.send(new GetObjectCommand({ Bucket: 'builting-ifc', Key: key }));

    const buffer = await response.Body.transformToByteArray();
    const base64 = Buffer.from(buffer).toString('base64');

    return {
      fileData: base64,
      fileName: `render-${renderId}.ifc`,
      render
    };
  },

  finalizeRender: async (userId, renderId) => {
    console.log('Finalizing render:', { userId, renderId });

    // Check if render exists
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    // Idempotent: if already finalized, return success
    if (render.upload_finalized) {
      console.log(`Render ${renderId} already finalized`);
      return { message: 'Render already finalized', renderId };
    }

    // Reject if zero files uploaded — list S3 objects under this render
    const prefix = `uploads/${userId}/${renderId}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: 'builting-data',
      Prefix: prefix
    }));

    const files = (listResult.Contents || []).filter(obj => obj.Key !== prefix);
    if (files.length === 0) {
      return { error: 'No files uploaded. Upload at least one file before finalizing.', statusCode: 400 };
    }

    // Store file manifest (truth set) and set finalized flag
    const fileManifest = files.map(f => ({
      key: f.Key,
      name: f.Key.split('/').pop(),
      size: f.Size
    }));

    await dynamo.send(new UpdateCommand({
      TableName,
      Key: { user_id: userId, render_id: renderId },
      UpdateExpression: 'SET upload_finalized = :true, fileManifest = :manifest, orchestration_started = :true',
      ExpressionAttributeValues: {
        ':true': true,
        ':manifest': fileManifest
      }
    }));
    console.log(`Render ${renderId} finalized with ${fileManifest.length} files`);

    // Start Step Function directly
    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (stateMachineArn) {
      const executionResult = await sfn.send(new StartExecutionCommand({
        stateMachineArn,
        input: JSON.stringify({ userId, renderId, bucket: 'builting-data' }),
        name: `render-${renderId}-${Date.now()}`
      }));
      console.log(`Step Function started: ${executionResult.executionArn}`);
    } else {
      console.warn('STATE_MACHINE_ARN not set, Step Function not started');
    }

    return { message: 'Render finalized and pipeline started', renderId, fileCount: fileManifest.length };
  },

  deleteRender: async (userId, renderId) => {
    console.log('Deleting render:', { userId, renderId });

    try {
      // Get render record to find S3 paths
      const render = await renders.getRender(userId, renderId);
      if (render.error) {
        return render; // Render not found
      }

      // Delete source files from builting-data bucket
      const sourceFolder = `uploads/${userId}/${renderId}/`;
      await deleteS3Folder('builting-data', sourceFolder);
      console.log('Deleted source files from S3');

      // Delete IFC file from builting-ifc bucket (if exists)
      if (render.ifc_s3_path) {
        const ifcKey = render.ifc_s3_path.replace('s3://builting-ifc/', '');
        await s3.send(
          new DeleteObjectCommand({
            Bucket: 'builting-ifc',
            Key: ifcKey
          })
        );
        console.log('Deleted IFC file from S3');
      }

      // Delete DynamoDB record
      await dynamo.send(
        new DeleteCommand({
          TableName,
          Key: { user_id: userId, render_id: renderId }
        })
      );
      console.log('Deleted render record from DynamoDB');

      return { message: 'Render deleted successfully' };
    } catch (error) {
      console.error('Error deleting render:', error);
      throw error;
    }
  }
};

/**
 * Delete all objects in an S3 folder (prefix)
 */
async function deleteS3Folder(bucket, prefix) {
  let continuationToken = null;

  do {
    const listParams = {
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    };

    const listResult = await s3.send(new ListObjectsV2Command(listParams));

    if (!listResult.Contents || listResult.Contents.length === 0) {
      break;
    }

    // Delete each object in the folder
    for (const object of listResult.Contents) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: object.Key
        })
      );
    }

    // Handle pagination
    if (listResult.IsTruncated) {
      continuationToken = listResult.NextContinuationToken;
    } else {
      break;
    }
  } while (continuationToken);

  console.log(`Deleted all objects with prefix ${prefix} from ${bucket}`);
}

export default renders;
