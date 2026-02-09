#!/usr/bin/env node

/**
 * Seed Test Data Script
 *
 * Populates DynamoDB and S3 with test data for the BuilTing app
 *
 * Usage:
 *   cd scripts
 *   npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-s3
 *   node seed-test-data.js
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';

// Configuration
const REGION = 'us-east-1';
const TEST_USER_EMAIL = 'nkoujala@gmail.com';
const S3_BUCKET = 'builting-data';
const TUNNEL_IFC_PATH = resolve(
  process.cwd(),
  '../Tunnel_StructureOnly_Example01_Revit.ifc'
);

// Initialize AWS clients
const dynamoClient = new DynamoDBClient({ region: REGION });
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({ region: REGION });

/**
 * Get user by email
 */
async function getUserByEmail(email) {
  try {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: 'builting-users',
        IndexName: 'email-index',
        KeyConditionExpression: 'email = :email',
        ExpressionAttributeValues: {
          ':email': email
        }
      })
    );
    return result.Items?.[0] || null;
  } catch (error) {
    console.error('Error fetching user:', error);
    throw error;
  }
}

/**
 * Upload tunnel IFC to S3
 */
async function uploadTunnelIfc(userId, renderId) {
  try {
    const fileContent = readFileSync(TUNNEL_IFC_PATH);
    const s3Key = `outputs/${userId}/${renderId}/Tunnel_StructureOnly_Example01_Revit.ifc`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: fileContent,
        ContentType: 'application/x-step'
      })
    );

    console.log(`✓ Uploaded tunnel IFC to S3: ${s3Key}`);
    return s3Key;
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
}

/**
 * Create test render
 */
async function createTestRender(userId, ifcS3Key) {
  try {
    const renderId = randomUUID();
    const timestamp = Date.now();

    const render = {
      id: renderId,
      user_id: userId,
      source_documents: [],
      ifc_s3_key: ifcS3Key,
      title: 'Tunnel Structure Example',
      description: 'Test render with tunnel IFC file. Ready for viewing and testing.',
      bedrock_trace: {
        steps: [
          {
            step: 'seed-script',
            model: 'test-data',
            note: 'Created by seed script for testing'
          }
        ]
      },
      status: 'completed',
      timestamp: timestamp
    };

    await dynamo.send(
      new PutCommand({
        TableName: 'builting-renders',
        Item: render
      })
    );

    console.log(`✓ Created test render: ${renderId}`);
    return render;
  } catch (error) {
    console.error('Error creating render:', error);
    throw error;
  }
}

/**
 * Main script
 */
async function main() {
  console.log('\n🚀 BuilTing Seed Script - Populating Test Data\n');

  try {
    // Step 1: Get user
    console.log(`1️⃣  Fetching user: ${TEST_USER_EMAIL}`);
    const user = await getUserByEmail(TEST_USER_EMAIL);

    if (!user) {
      console.error(
        `❌ User not found: ${TEST_USER_EMAIL}\n` +
        `Please create this user first via the login page or manually in DynamoDB`
      );
      process.exit(1);
    }

    console.log(`   User ID: ${user.id}`);
    console.log(`   Name: ${user.name}`);

    // Step 2: Upload tunnel IFC
    console.log(`\n2️⃣  Uploading tunnel IFC to S3`);
    const renderId = randomUUID();
    const ifcS3Key = await uploadTunnelIfc(user.id, renderId);

    // Step 3: Create test render
    console.log(`\n3️⃣  Creating test render record`);
    const render = await createTestRender(user.id, ifcS3Key);
    console.log(`   Render ID: ${render.id}`);
    console.log(`   Status: ${render.status}`);

    console.log('\n✅ Test data setup complete!\n');
    console.log('You can now:');
    console.log(`1. Login as ${TEST_USER_EMAIL}`);
    console.log('2. You should see 1 render in the sidebar: "Tunnel Structure Example" ✅');
    console.log('3. Click the render to view the 3D tunnel structure');
    console.log('4. Try uploading new files and creating renders (will stay in "processing" until ML pipeline is built)\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Run script
main();
