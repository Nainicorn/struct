# Lambda Deployment Guide

## Summary of Changes

I've fixed the DynamoDB key schema issue that was causing the "ValidationException: The provided key element does not match the schema" error. The issue was that the DynamoDB table uses `user_id` and `render_id` (with underscores), but the Lambda code was using camelCase (`userId`, `renderId`).

**All four Lambda functions now use the correct key names:**
- `user_id` (Partition Key)
- `render_id` (Sort Key)

## Files Created

```
src/
├── builting-main/
│   ├── read-metadata.mjs         (NEW - also in separate directory)
│   ├── bedrock-ifc.mjs           (NEW - also in separate directory)
│   ├── store-ifc.mjs             (NEW - also in separate directory)
│   ├── orchestrator-trigger.mjs  (NEW - also in separate directory)
│   └── builting-main.zip         (UPDATED with new modules)
│
├── builting-read-metadata/
│   ├── index.mjs
│   └── package.json
│
├── builting-bedrock-ifc/
│   ├── index.mjs
│   └── package.json
│
├── builting-store-ifc/
│   ├── index.mjs
│   └── package.json
│
└── builting-orchestrator-trigger/
    ├── index.mjs
    └── package.json
```

## Deployment Steps

### 1. Deploy builting-main (Updated)

The updated `builting-main.zip` includes all the fixed modules. Upload it to your `builting-main` Lambda function:

```bash
cd src/builting-main
# builting-main.zip is ready to upload
```

### 2. Deploy builting-read-metadata

```bash
cd src/builting-read-metadata
npm install --omit=dev
zip -r function.zip index.mjs node_modules/
```

**In AWS Lambda:**
- Function name: `builting-read-metadata`
- Handler: `index.handler`
- Runtime: Node.js 20.x
- Timeout: 300 seconds
- IAM Role: `builting-lambda-execution-role` (with DynamoDB + S3 access)

### 3. Deploy builting-bedrock-ifc

```bash
cd src/builting-bedrock-ifc
npm install --omit=dev
zip -r function.zip index.mjs node_modules/
```

**In AWS Lambda:**
- Function name: `builting-bedrock-ifc`
- Handler: `index.handler`
- Runtime: Node.js 20.x
- Timeout: 300 seconds (Bedrock calls can be slow)
- IAM Role: `builting-lambda-execution-role` (with Bedrock + S3 access)
- Memory: 1024 MB or higher (for large IFC generation)

### 4. Deploy builting-store-ifc

```bash
cd src/builting-store-ifc
npm install --omit=dev
zip -r function.zip index.mjs node_modules/
```

**In AWS Lambda:**
- Function name: `builting-store-ifc`
- Handler: `index.handler`
- Runtime: Node.js 20.x
- Timeout: 300 seconds
- IAM Role: `builting-lambda-execution-role` (with DynamoDB + S3 access)

### 5. Deploy builting-orchestrator-trigger

```bash
cd src/builting-orchestrator-trigger
npm install --omit=dev
zip -r function.zip index.mjs node_modules/
```

**In AWS Lambda:**
- Function name: `builting-orchestrator-trigger`
- Handler: `index.handler`
- Runtime: Node.js 20.x
- Timeout: 60 seconds
- IAM Role: `builting-lambda-execution-role` (with DynamoDB + Step Functions access)
- **Environment Variable:**
  - `STATE_MACHINE_ARN`: `arn:aws:states:us-east-1:YOUR_ACCOUNT_ID:stateMachine:builting-render-state-machine`

### 6. Configure S3 → SNS → Lambda

1. Open S3 bucket `builting-data`
2. Go to **Properties** → **Event notifications**
3. Create notification:
   - **Event types**: `s3:ObjectCreated:*`
   - **Prefix**: `uploads/`
   - **Destination**: SNS topic `builting-render-triggers`

4. In SNS topic `builting-render-triggers`, add subscription:
   - **Protocol**: Lambda
   - **Endpoint**: ARN of `builting-orchestrator-trigger`

### 7. Verify Step Function State Machine

Update your Step Function `builting-render-state-machine` to use the correct Lambda ARNs:

```json
{
  "ReadMetadata": {
    "Type": "Task",
    "Resource": "arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:builting-read-metadata",
    "Next": "BedrockInvokeIFC"
  },
  "BedrockInvokeIFC": {
    "Type": "Task",
    "Resource": "arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:builting-bedrock-ifc",
    "TimeoutSeconds": 300,
    "Next": "StoreIFC"
  },
  "StoreIFC": {
    "Type": "Task",
    "Resource": "arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:builting-store-ifc",
    "Next": "UpdateCompleted"
  }
}
```

## Testing

### Manual Test via Step Function Console

1. Open Step Function `builting-render-state-machine`
2. Click **Start execution**
3. Input:
```json
{
  "userId": "user-1",
  "renderId": "test-render-uuid",
  "bucket": "builting-data"
}
```
4. Watch execution - should complete all tasks without validation errors

### Full End-to-End Test

1. Login to frontend
2. Upload files + description
3. Watch loading spinner
4. After completion, verify:
   - DynamoDB record has `status: 'completed'`
   - IFC file exists in `s3://builting-ifc/user-1/render-id/output.ifc`
   - Frontend displays IFC in viewer

## Troubleshooting

**Error: "ValidationException: The provided key element does not match the schema"**
- Verify Lambda is using `user_id` and `render_id` (NOT `userId`/`renderId`)
- Verify DynamoDB table keys are `user_id` (String) and `render_id` (String)

**Error: "Lambda function not found"**
- Verify Lambda ARNs in Step Function definition are correct
- Verify Lambda functions are in same region (us-east-1)

**Error: "BedrockInvokeIFC failed to call Bedrock"**
- Verify IAM role has `AmazonBedrockFullAccess` policy
- Verify model ID is available in region

**S3 events not triggering**
- Verify S3 event notification is configured correctly
- Verify SNS topic has Lambda subscription
- Check SNS topic permissions allow S3 to publish

## Key Fixes Made

1. **DynamoDB Key Names**: Changed all Lambda code to use `user_id` and `render_id` (snake_case)
2. **getDownloadUrl**: Uses `ifc_s3_path` field from DynamoDB to generate presigned URL
3. **rendersService**: Updated to use query parameters for userId (not cookies)
4. **Frontend Polling**: Exponential backoff 2s→5s→10s with 10min timeout
5. **Description Handling**: Text description uploaded as `description.txt` to S3

All code now matches the DynamoDB table schema and should work seamlessly with the Step Function pipeline.
