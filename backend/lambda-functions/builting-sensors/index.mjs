import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const SENSORS_TABLE = process.env.SENSORS_TABLE || 'builting-sensors';

// Sensor type definitions — single source of truth for ranges, units, and labels
const SENSOR_TYPES = {
  TEMPERATURE:      { unit: 'C',   min: 18, max: 26, label: 'Temperature' },
  AIRFLOW:          { unit: 'm/s', min: 0.5, max: 5.0, label: 'Airflow' },
  EQUIPMENT_STATUS: { unit: null,  values: ['running', 'idle', 'fault'], label: 'Equipment Status' },
  STRUCTURAL_LOAD:  { unit: '%',   min: 50, max: 95, label: 'Structural Load' },
};

// IFC type → sensor type mapping
const ELEMENT_SENSOR_MAP = {
  'IfcSpace':        'TEMPERATURE',
  'IfcDuctSegment':  'AIRFLOW',
  'IfcFan':          'EQUIPMENT_STATUS',
  'IfcPump':         'EQUIPMENT_STATUS',
  'IfcColumn':       'STRUCTURAL_LOAD',
  'IfcBeam':         'STRUCTURAL_LOAD',
};

const MAX_SENSORS_PER_TYPE = 20;

export const handler = async (event) => {
  console.log('SensorService input:', JSON.stringify(event).substring(0, 500));

  const { renderId, action } = event;

  if (action === 'refresh') {
    return await refreshSensors(renderId);
  }

  return await generateSensors(event);
};

/**
 * Generate sensor definitions for a completed render based on its element counts.
 * Called by the Step Function after StoreIFC.
 */
async function generateSensors(event) {
  const { renderId, userId, elementCounts } = event;

  if (!renderId || !elementCounts) {
    console.log('Missing renderId or elementCounts, skipping sensor generation');
    return { renderId, sensorsCreated: 0 };
  }

  const sensors = [];
  const typeCounts = {}; // Track count per sensor type for cap enforcement

  for (const [ifcType, count] of Object.entries(elementCounts)) {
    const sensorType = ELEMENT_SENSOR_MAP[ifcType];
    if (!sensorType || count <= 0) continue;

    const config = SENSOR_TYPES[sensorType];
    typeCounts[sensorType] = typeCounts[sensorType] || 0;

    const remaining = MAX_SENSORS_PER_TYPE - typeCounts[sensorType];
    if (remaining <= 0) continue;

    const sensorCount = Math.min(count, remaining);

    for (let i = 0; i < sensorCount; i++) {
      typeCounts[sensorType]++;
      const index = typeCounts[sensorType];
      const sensorId = `sensor-${sensorType.toLowerCase()}-${index}`;

      const sensor = {
        render_id: renderId,
        sensor_id: sensorId,
        element_id: `${ifcType}_${i + 1}`,
        element_type: ifcType,
        sensor_type: sensorType,
        display_name: `${config.label} ${index}`,
        status: 'normal',
        last_updated: Date.now(),
        canonical_id: null, // Reserved for future per-element binding
      };

      if (config.values) {
        // Categorical sensor (equipment status)
        sensor.current_value = 'running';
        sensor.unit = null;
        sensor.min_range = null;
        sensor.max_range = null;
      } else {
        // Numeric sensor — randomize initial value within normal range
        const range = config.max - config.min;
        sensor.current_value = Math.round((config.min + Math.random() * range) * 100) / 100;
        sensor.unit = config.unit;
        sensor.min_range = config.min;
        sensor.max_range = config.max;
      }

      sensors.push(sensor);
    }
  }

  if (sensors.length === 0) {
    console.log('No sensor-eligible elements found');
    return { renderId, sensorsCreated: 0 };
  }

  // BatchWriteItem (max 25 items per batch)
  const batches = [];
  for (let i = 0; i < sensors.length; i += 25) {
    const batch = sensors.slice(i, i + 25).map(item => ({
      PutRequest: { Item: item }
    }));
    batches.push(batch);
  }

  for (const batch of batches) {
    await dynamo.send(new BatchWriteCommand({
      RequestItems: { [SENSORS_TABLE]: batch }
    }));
  }

  console.log(`Seeded ${sensors.length} sensors for render ${renderId}`);
  return { renderId, sensorsCreated: sensors.length };
}

/**
 * Refresh all sensors for a render with randomized value variations.
 * Simulates live telemetry updates.
 */
async function refreshSensors(renderId) {
  if (!renderId) throw new Error('renderId required for refresh');

  // Query all sensors for this render
  const result = await dynamo.send(new QueryCommand({
    TableName: SENSORS_TABLE,
    KeyConditionExpression: 'render_id = :rid',
    ExpressionAttributeValues: { ':rid': renderId }
  }));

  const sensors = result.Items || [];
  if (sensors.length === 0) {
    return { renderId, refreshed: 0 };
  }

  const now = Date.now();

  for (const sensor of sensors) {
    const config = SENSOR_TYPES[sensor.sensor_type];
    if (!config) continue;

    let newValue = sensor.current_value;
    let newStatus = sensor.status;

    if (config.values) {
      // Equipment status: 90% stay same, 5% warning (idle), 5% change
      const roll = Math.random();
      if (roll < 0.01) {
        newValue = 'fault';
        newStatus = 'critical';
      } else if (roll < 0.06) {
        newValue = 'idle';
        newStatus = 'warning';
      } else if (roll < 0.10) {
        newValue = 'running';
        newStatus = 'normal';
      }
    } else {
      // Numeric: drift ±5-15% of range
      const range = config.max - config.min;
      const drift = (Math.random() - 0.5) * range * 0.15;
      newValue = Math.round(Math.max(config.min * 0.8, Math.min(config.max * 1.2, sensor.current_value + drift)) * 100) / 100;

      // Status based on value position
      const normalized = (newValue - config.min) / (config.max - config.min);
      if (normalized > 1.0 || normalized < -0.1) {
        newStatus = 'critical';
      } else if (normalized > 0.85 || normalized < 0.05) {
        newStatus = 'warning';
      } else {
        newStatus = 'normal';
      }
    }

    await dynamo.send(new UpdateCommand({
      TableName: SENSORS_TABLE,
      Key: { render_id: renderId, sensor_id: sensor.sensor_id },
      UpdateExpression: 'SET current_value = :v, #s = :st, last_updated = :t',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':v': newValue,
        ':st': newStatus,
        ':t': now
      }
    }));
  }

  console.log(`Refreshed ${sensors.length} sensors for render ${renderId}`);
  return { renderId, refreshed: sensors.length };
}
