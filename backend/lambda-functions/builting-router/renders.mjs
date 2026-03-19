import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});
const sfn = new SFNClient({});

const TableName = process.env.RENDERS_TABLE || 'builting-renders';
const DATA_BUCKET = process.env.DATA_BUCKET || 'builting-data';
const IFC_BUCKET = process.env.IFC_BUCKET || 'builting-ifc';
const SENSORS_TABLE = process.env.SENSORS_TABLE || 'builting-sensors';

const renders = {
  handle: async (event) => {
    const userId = event._authenticatedUserId;

    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const path = event.path || event.rawPath || '';

    try {
      // POST /api/renders/{renderId}/refine - refine with engineer correction
      if (method === 'POST' && path.includes('/refine')) {
        const renderId = path.split('/').slice(-2)[0];
        const body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
        return await renders.refineRender(userId, renderId, body.refinement);
      }

      // POST /api/renders/{renderId}/retry - retry a failed render
      if (method === 'POST' && path.includes('/retry')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.retryRender(userId, renderId);
      }

      // POST /api/renders/{renderId}/finalize - finalize upload and start pipeline
      if (method === 'POST' && path.includes('/finalize')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.finalizeRender(userId, renderId);
      }

      // GET /api/renders/{renderId}/download - download IFC/glTF/OBJ
      if (method === 'GET' && path.includes('/download')) {
        const renderId = path.split('/').slice(-2)[0];
        const format = (event.queryStringParameters?.format || 'ifc').toLowerCase();
        return await renders.getDownloadUrl(userId, renderId, format);
      }

      // GET /api/renders/{renderId}/report - download verification report
      if (method === 'GET' && path.includes('/report')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.getVerificationReport(userId, renderId);
      }

      // GET /api/renders/{renderId}/sources/{fileName} - download source file
      if (method === 'GET' && path.includes('/sources/')) {
        const parts = path.split('/');
        const sourcesIdx = parts.indexOf('sources');
        const renderId = parts[sourcesIdx - 1];
        const fileName = decodeURIComponent(parts[sourcesIdx + 1]);
        return await renders.getSourceFile(userId, renderId, fileName);
      }

      // POST /api/renders/{renderId}/sensors/refresh - refresh simulated sensor data
      if (method === 'POST' && path.includes('/sensors/refresh')) {
        const parts = path.split('/');
        const sensorsIdx = parts.indexOf('sensors');
        const renderId = parts[sensorsIdx - 1];
        return await renders.refreshSensors(userId, renderId);
      }

      // GET /api/renders/{renderId}/sensors - list sensors (or get specific sensor)
      if (method === 'GET' && path.includes('/sensors')) {
        const parts = path.split('/');
        const sensorsIdx = parts.indexOf('sensors');
        const renderId = parts[sensorsIdx - 1];
        const sensorId = parts[sensorsIdx + 1];
        if (sensorId) {
          return await renders.getSensor(userId, renderId, sensorId);
        }
        return await renders.listSensors(userId, renderId);
      }

      // GET /api/renders - list all renders for user
      if (method === 'GET') {
        const renderId = path.split('/').pop();
        if (renderId && renderId !== 'renders' && renderId !== 'api') {
          return await renders.getRender(userId, renderId);
        }
        return await renders.listRenders(userId);
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
      status: 'uploading',
      created_at: Math.floor(Date.now() / 1000),
      source_files: fileNames,
      s3_path: `s3://${DATA_BUCKET}/uploads/${userId}/${renderId}`,
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

  getDownloadUrl: async (userId, renderId, format = 'ifc') => {
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    if (render.status !== 'completed') {
      return { error: `Render is ${render.status}, not ready for download`, statusCode: 400 };
    }

    // Resolve file key, content type, and filename based on requested format
    const formatConfig = {
      ifc: {
        key: render.ifc_s3_path.replace(`s3://${IFC_BUCKET}/`, ''),
        contentType: 'application/octet-stream',
        ext: 'ifc'
      },
      glb: {
        key: `${userId}/${renderId}/model.glb`,
        contentType: 'model/gltf-binary',
        ext: 'glb'
      },
      gltf: {
        key: `${userId}/${renderId}/model.glb`,
        contentType: 'model/gltf-binary',
        ext: 'glb'
      },
      obj: {
        key: `${userId}/${renderId}/model.obj`,
        contentType: 'text/plain',
        ext: 'obj'
      }
    };

    const config = formatConfig[format];
    if (!config) {
      return { error: `Unsupported format: ${format}. Available: ifc, glb, obj`, statusCode: 400 };
    }

    // For non-IFC formats, check if the format was actually exported
    if (format !== 'ifc') {
      const available = render.exportFormats || ['IFC4'];
      const formatLabel = format === 'obj' ? 'OBJ' : 'glTF';
      if (!available.includes(formatLabel)) {
        return { error: `Format ${formatLabel} not available for this render. Available: ${available.join(', ')}`, statusCode: 404 };
      }
    }

    const command = new GetObjectCommand({
      Bucket: IFC_BUCKET,
      Key: config.key,
      ResponseContentType: config.contentType,
      ResponseContentDisposition: `attachment; filename="render-${renderId}.${config.ext}"`
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    return {
      downloadUrl,
      fileName: `render-${renderId}.${config.ext}`,
      format: config.ext,
      render
    };
  },

  getSourceFile: async (userId, renderId, fileName) => {
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    // Validate the file is in source_files list
    if (!render.source_files || !render.source_files.includes(fileName)) {
      return { error: 'File not found in this render', statusCode: 404 };
    }

    const key = `uploads/${userId}/${renderId}/${fileName}`;
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
      const buffer = await response.Body.transformToByteArray();
      const base64 = Buffer.from(buffer).toString('base64');

      return {
        fileData: base64,
        fileName
      };
    } catch (err) {
      console.error('Error fetching source file:', err.message);
      return { error: 'File not found in storage', statusCode: 404 };
    }
  },

  getVerificationReport: async (userId, renderId) => {
    const key = `uploads/${userId}/${renderId}/reports/verification_report.json`;
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
      const buffer = await response.Body.transformToByteArray();
      const reportJson = Buffer.from(buffer).toString('utf-8');
      return { report: JSON.parse(reportJson) };
    } catch (err) {
      console.error('Error fetching verification report:', err.message);
      return { error: 'Verification report not found', statusCode: 404 };
    }
  },

  finalizeRender: async (userId, renderId) => {
    console.log('Finalizing render:', { userId, renderId });

    // Fail fast if STATE_MACHINE_ARN is not configured
    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      console.error('STATE_MACHINE_ARN not set');
      return { error: 'Pipeline not configured', statusCode: 500 };
    }

    // Check if render exists
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    // Idempotent: if already past uploading, return deterministic response
    if (render.status !== 'uploading') {
      console.log(`Render ${renderId} already finalized (status: ${render.status})`);
      return { message: 'Render already finalized', renderId, status: render.status };
    }

    // Reject if zero files uploaded — list S3 objects under this render
    const prefix = `uploads/${userId}/${renderId}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: DATA_BUCKET,
      Prefix: prefix
    }));

    const files = (listResult.Contents || []).filter(obj => obj.Key !== prefix);
    if (files.length === 0) {
      return { error: 'No files uploaded. Upload at least one file before finalizing.', statusCode: 400 };
    }

    // Store file manifest and transition status uploading → processing (conditional)
    const fileManifest = files.map(f => ({
      key: f.Key,
      name: f.Key.split('/').pop(),
      size: f.Size
    }));

    try {
      await dynamo.send(new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: 'SET #status = :processing, upload_finalized = :true, fileManifest = :manifest',
        ConditionExpression: '#status = :uploading',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ':uploading': 'uploading',
          ':true': true,
          ':manifest': fileManifest
        }
      }));
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.log(`Render ${renderId} status changed concurrently, already finalized`);
        return { message: 'Render already finalized', renderId };
      }
      throw err;
    }
    console.log(`Render ${renderId} finalized with ${fileManifest.length} files`);

    // Start Step Function
    const executionResult = await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({ userId, renderId, bucket: DATA_BUCKET }),
      name: `render-${renderId}-${Date.now()}`
    }));
    console.log(`Step Function started: ${executionResult.executionArn}`);

    return { message: 'Render finalized and pipeline started', renderId, fileCount: fileManifest.length };
  },

  retryRender: async (userId, renderId) => {
    console.log('Retrying render:', { userId, renderId });

    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      return { error: 'Pipeline not configured', statusCode: 500 };
    }

    // Get the render record
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    // Only allow retry for failed renders
    if (render.status !== 'failed') {
      return { error: `Cannot retry render with status '${render.status}'. Only failed renders can be retried.`, statusCode: 400 };
    }

    // Verify files still exist in S3
    const prefix = `uploads/${userId}/${renderId}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: DATA_BUCKET,
      Prefix: prefix
    }));

    const files = (listResult.Contents || []).filter(obj => obj.Key !== prefix);
    if (files.length === 0) {
      return { error: 'Original source files no longer available in S3. Please create a new render.', statusCode: 400 };
    }

    // Reset status to processing and clear error
    try {
      await dynamo.send(new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: 'SET #status = :processing, retry_count = if_not_exists(retry_count, :zero) + :one REMOVE error_message',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ':zero': 0,
          ':one': 1
        }
      }));
    } catch (err) {
      console.error('Failed to reset render status:', err);
      return { error: 'Failed to reset render for retry', statusCode: 500 };
    }

    // Re-start Step Function
    const executionResult = await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({ userId, renderId, bucket: DATA_BUCKET }),
      name: `render-${renderId}-retry-${Date.now()}`
    }));
    console.log(`Retry Step Function started: ${executionResult.executionArn}`);

    return { message: 'Render retry started', renderId, fileCount: files.length };
  },

  refineRender: async (userId, renderId, refinementText) => {
    if (!refinementText || typeof refinementText !== 'string' || !refinementText.trim()) {
      return { error: 'refinement text is required', statusCode: 400 };
    }

    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) return { error: 'Pipeline not configured', statusCode: 500 };

    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;
    if (render.status !== 'completed') {
      return { error: 'Can only refine completed renders', statusCode: 400 };
    }

    // Fetch previous PROCESSED CSS from S3 so extract can use it as a modification base.
    // Use css_processed.json (post-transform, validated) instead of css_raw.json (pre-validation)
    // because the processed version is what actually produced the working IFC.
    let previousCSS = null;
    const cssKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
    try {
      const cssResponse = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: cssKey }));
      const cssBuffer = await cssResponse.Body.transformToByteArray();
      previousCSS = JSON.parse(Buffer.from(cssBuffer).toString('utf-8'));
      console.log(`Loaded previous CSS from ${cssKey}`);
    } catch (err) {
      console.warn(`Could not load previous CSS (${cssKey}):`, err.message);
    }

    // Update existing render in-place: set status to processing, store refinement
    try {
      await dynamo.send(new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: 'SET #status = :processing, refinement = :refinement, refine_count = if_not_exists(refine_count, :zero) + :one, render_revision = if_not_exists(render_revision, :zero) + :one',
        ConditionExpression: '#status = :completed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ':completed': 'completed',
          ':refinement': refinementText.trim(),
          ':zero': 0,
          ':one': 1
        }
      }));
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        return { error: 'Render status changed, please try again', statusCode: 409 };
      }
      throw err;
    }

    // Start Step Function with same renderId + previousCSS
    const sfInput = { userId, renderId, bucket: DATA_BUCKET };
    if (previousCSS) sfInput.previousCSS = previousCSS;

    const executionResult = await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(sfInput),
      name: `refine-${renderId}-${Date.now()}`
    }));
    console.log(`Refine pipeline started: ${executionResult.executionArn}`);

    return { renderId, message: 'Refinement pipeline started' };
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
      await deleteS3Folder(DATA_BUCKET, sourceFolder);
      console.log('Deleted source files from S3');

      // Delete all export files from builting-ifc bucket (IFC + glTF + OBJ)
      const ifcFolder = `${userId}/${renderId}/`;
      await deleteS3Folder(IFC_BUCKET, ifcFolder);
      console.log('Deleted IFC and export files from S3');

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

// ==================== Sensor Telemetry ====================

const SENSOR_TYPES = {
  TEMPERATURE:      { unit: 'C',   min: 18, max: 26, label: 'Temperature' },
  AIRFLOW:          { unit: 'm/s', min: 0.5, max: 5.0, label: 'Airflow' },
  EQUIPMENT_STATUS: { unit: null,  values: ['running', 'idle', 'fault'], label: 'Equipment Status' },
  STRUCTURAL_LOAD:  { unit: '%',   min: 50, max: 95, label: 'Structural Load' },
};

/**
 * List all sensors for a render.
 */
renders.listSensors = async function(userId, renderId) {
  // Verify ownership
  const render = await renders.getRender(userId, renderId);
  if (render.error) return render;

  const result = await dynamo.send(new QueryCommand({
    TableName: SENSORS_TABLE,
    KeyConditionExpression: 'render_id = :rid',
    ExpressionAttributeValues: { ':rid': renderId }
  }));

  return { sensors: result.Items || [] };
};

/**
 * Get a single sensor by ID.
 */
renders.getSensor = async function(userId, renderId, sensorId) {
  const render = await renders.getRender(userId, renderId);
  if (render.error) return render;

  const result = await dynamo.send(new GetCommand({
    TableName: SENSORS_TABLE,
    Key: { render_id: renderId, sensor_id: sensorId }
  }));

  if (!result.Item) return { error: 'Sensor not found', statusCode: 404 };
  return { sensor: result.Item };
};

/**
 * Refresh all sensors for a render with simulated value variations.
 */
renders.refreshSensors = async function(userId, renderId) {
  const render = await renders.getRender(userId, renderId);
  if (render.error) return render;

  const result = await dynamo.send(new QueryCommand({
    TableName: SENSORS_TABLE,
    KeyConditionExpression: 'render_id = :rid',
    ExpressionAttributeValues: { ':rid': renderId }
  }));

  const sensors = result.Items || [];
  if (sensors.length === 0) return { sensors: [], refreshed: 0 };

  const now = Date.now();

  for (const sensor of sensors) {
    const config = SENSOR_TYPES[sensor.sensor_type];
    if (!config) continue;

    let newValue = sensor.current_value;
    let newStatus = sensor.status;

    if (config.values) {
      const roll = Math.random();
      if (roll < 0.01) { newValue = 'fault'; newStatus = 'critical'; }
      else if (roll < 0.06) { newValue = 'idle'; newStatus = 'warning'; }
      else if (roll < 0.10) { newValue = 'running'; newStatus = 'normal'; }
    } else {
      const range = config.max - config.min;
      const drift = (Math.random() - 0.5) * range * 0.15;
      newValue = Math.round(Math.max(config.min * 0.8, Math.min(config.max * 1.2, sensor.current_value + drift)) * 100) / 100;

      const normalized = (newValue - config.min) / (config.max - config.min);
      if (normalized > 1.0 || normalized < -0.1) newStatus = 'critical';
      else if (normalized > 0.85 || normalized < 0.05) newStatus = 'warning';
      else newStatus = 'normal';
    }

    await dynamo.send(new UpdateCommand({
      TableName: SENSORS_TABLE,
      Key: { render_id: renderId, sensor_id: sensor.sensor_id },
      UpdateExpression: 'SET current_value = :v, #s = :st, last_updated = :t',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':v': newValue, ':st': newStatus, ':t': now }
    }));
  }

  // Re-query to return updated sensors
  const updated = await dynamo.send(new QueryCommand({
    TableName: SENSORS_TABLE,
    KeyConditionExpression: 'render_id = :rid',
    ExpressionAttributeValues: { ':rid': renderId }
  }));

  return { sensors: updated.Items || [], refreshed: sensors.length };
};

export default renders;
