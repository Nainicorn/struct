# Text-to-3D Project Status & Architecture

## 📋 Project Overview

A full-stack application for converting text descriptions + files into 3D IFC files using AWS Bedrock Lambda. Users can create renders (upload files + plaintext description) and view previously generated 3D models.

**Core Flow**: User login -> User has access to view old renders -> user starts new render -> user uploads new files and documents -> files and documents get stored in S3 properly -> AI flow begins for IFC generation -> ifc file is generated and stored in S3 as well -> frontend retrieved the file to display to user -> user sees file displayed visually, associated raw data that created the file which is what the user initially uploaded, and an ai generated description and title as well as capability to download the file to view in revit or unity

**Current Setup**:
- Lambda: builting-main (auth, renders, upload logic)
- DynamoDB: builting-users table, and buiting-renders table
- S3 buckets: builting-data and builting-ifc
- API Gateway: builting-api
- Planned: builting-orchestrator Lambda

**Tech Stack**:
- **Frontend**: Vite + Vanilla JavaScript + Handlebars templates
- **Backend**: AWS API Gateway + Lambda + DynamoDB + S3
- **3D Processing**: Bedrock (Claude) Lambda + AWS Step Functions
- **Viewer**: web-ifc + Three.js

---

## ⚡ QUICK STATUS (Update this section regularly)

✅ COMPLETE:
- builting-main Lambda deployed (auth, renders, upload, S3 cleanup on delete)
- builting-bedrock-ifc Lambda deployed (generates IFC from Bedrock)
- builting-store-ifc Lambda deployed (stores IFC to S3, updates DynamoDB)
- builting-read-metadata Lambda deployed
- builting-orchestrator-trigger Lambda deployed
- Step Function (builting-render-state-machine) deployed
- Frontend CRUD system implemented (sidebar, renderbox, details)
- CORS configured in API Gateway
- DynamoDB schema finalized (user_id, render_id with ifc_s3_path)

TO-DO:
- SNS topic (builting-render-triggers) is configured but not attached
- S3 event notifications need to be configured → SNS → Lambda
- theres a separate phase between bedrock and ifc that converts raw data to json then converts to ifc and theres a lambda image builting-json-to-ifc-python however it needs some tweaking to be better
- the generated ifc file needs to be properly rendered in the frontend ifc viewer -- xeokit not recignizing geometry 

**🐛 BUG FIXES (2026-02-18)**:

1. **IFC Entity Visualization** - xeokit not recognizing geometry
   - **Problem**: xeokit viewer showing empty scene, console logs indicate IFCSLAB entity type not recognized
   - **Root Cause**: xeokit has limited support for IFCSLAB; better support for IFCBEAM
   - **Solution**: Changed Lambda to generate IFCBEAM instead of IFCSLAB
   - **File**: `backend/builting-json-to-ifc-python/lambda_function.py` (line 138)
   - **Status**: ✅ Code fixed & tested locally with Docker
   - **Test Result**: ✓ IFCBEAM entity confirmed in generated IFC files
   - **Deployment Files**:
     - `builting-json-to-ifc-layer.zip` (57MB) - Lambda layer with ifcopenshell
     - `builting-bedrock-ifc.zip` (1.8KB) - Function code
   - **Next Step**: Deploy to AWS Lambda and test end-to-end

2. **Bedrock Token Limit Issue** (2026-02-18) - Previously fixed
   - Increased `max_tokens` from 4096 → 16384 in Bedrock invoke call
   - Allows complete IFC generation even with large/complex input
   - Step Function retry logic handles token limit failures
   - **File**: `backend/builting-bedrock-ifc/index.mjs` (line 240)

3. **Bedrock Prompt Quality** (initial fix, now enhanced)
   - Simplified & clarified prompt to explicitly request ISO-10303-21 STEP format
   - Added validation that rejects non-IFC responses
   - Step Function retry logic successfully handles failures
   - **File**: `backend/builting-bedrock-ifc/index.mjs` (lines 94-120: prompt; 270-280: validation)

**📋 REMAINING WORK**:
- **URGENT**: Deploy IFCBEAM changes to AWS:
  1. Create Lambda layer with `builting-json-to-ifc-layer.zip`
  2. Update or create Lambda function with `builting-bedrock-ifc.zip`
  3. Configure function to use the layer
  4. Update Step Function to invoke the new version
- Test with fresh render containing complex files (ventilation, CAD, PDFs, etc)
- Verify complete IFC generation and xeokit viewer loads correctly with IFCBEAM
- Consider further optimization (file compression, smarter tokenization)
- Reach goals (human-in-the-loop, edit renders, real-time updates, IFC previews)

---

## 🐛 Recent Fixes

### Bedrock Token Limit - Incomplete IFC Generation (2026-02-18)
**Problem**: On complex input files (1.3MB CAD + 566KB simulation + PDFs), first Step Function attempt fails with: `Error: Bedrock generated incomplete IFC - missing END-ISO-10303-21`

**Root Cause**: Bedrock's `max_tokens` was set to 4096, too small for generating complete IFC files from complex input. Claude runs out of tokens before completing the END-ISO-10303-21 marker.

**Solution**: Increased `max_tokens` from 4096 → 16384 in Bedrock InvokeModelCommand
- Gives Claude 4x more output budget
- Allows complete IFC generation even with large/complex input
- Step Function retry logic handles first failure gracefully

**Updated File**: `backend/builting-bedrock-ifc/index.mjs` (line 240)
```javascript
// Before: max_tokens: 4096
// After: max_tokens: 16384
```

**Status**: ✅ Code fixed, requires Lambda redeployment

**Evidence**: CloudWatch logs show:
- First attempt: ❌ Error "missing END-ISO-10303-21" (truncated)
- Second attempt (retry): ✅ "IFC generation complete" (successful)

### Bedrock Prompt Not Generating Valid IFC (2026-02-17)
**Problem**: IFC viewer fails with xeokit error - base64 data is only 2KB and contains text like "Here is the IFC data representing the building geometry and elements:\n\nISO-" instead of actual STEP format file content

**Root Cause**: Bedrock prompt in `builting-bedrock-ifc` was too vague and abstract. Despite instruction "RETURN ONLY THE RAW IFC FILE TEXT", Claude was generating a description of what an IFC file should be, not the actual file.

**Solution**:
1. Rewrote prompt to be more explicit and direct:
   - Old: Long detailed explanations of IFC syntax rules (too verbose/confusing)
   - New: Concise instruction with clear examples - "Your response MUST start with ISO-10303-21; and end with END-ISO-10303-21; Nothing else."
2. Added strict validation in Lambda handler:
   - Check response starts with `ISO-10303-21;`
   - Check response ends with `END-ISO-10303-21;`
   - Throw descriptive error if invalid (enables Step Function retry/fail)
3. Simplified prompt from 180+ lines to focused 25-line prompt

**Updated File**: `backend/builting-bedrock-ifc/index.mjs`
- Lines 94-120: New simplified prompt
- Lines 260-280: Validation logic with error handling

**Status**: ✅ Code fixed, requires Lambda redeployment

**Why This Matters**: Bedrock (Claude) is very amenable to instruction following, but requires explicit, clear boundaries. The old prompt had too much context and examples which confused the model about what the actual task was. The new prompt is unambiguous.

### IFC File Buffer Encoding (2026-02-17)
**Problem**: IFC file not loading in viewer after render completion - browser console shows `blob:http://localhost:5001/... net::ERR_FILE_NOT_FOUND` and xeokit `getXKT error: null`

**Root Cause**: `builting-store-ifc` Lambda storing IFC content as plain string to S3 without proper UTF-8 buffer encoding, causing retrieval issues

**Solution**: Convert string to Buffer before S3 upload:
```javascript
// Before: Body: ifcContent (raw string)
// After: Body: Buffer.from(ifcContent, 'utf-8')
```

**Updated File**: `backend/builting-store-ifc/index.mjs` (line 20-24)

**Status**: ✅ Code fixed, requires redeployment to AWS Lambda

### Bedrock Model Error (2026-02-12)
**Problem**: `ValidationException: Invocation of model ID anthropic.claude-3-5-sonnet-20241022-v2:0 with on-demand throughput isn't supported`

**Root Cause**: Claude 3.5 Sonnet requires inference profile (provisioned throughput), not available on-demand

**Solution**: Switched to `anthropic.claude-3-sonnet-20240229-v1:0` (Claude 3 Sonnet v1) which supports on-demand invocation

**Updated File**: `backend/builting-bedrock-ifc/index.mjs` (line 56)

### Frontend CRUD Implementation (2026-02-13)

**Problem**: Frontend lacked UI to view old renders, see render details, and delete renders with backend cleanup

**Solution**: Implemented complete CRUD system with details sidebar and thumbnail grid

**New Components Created**:
- **`ui/components/details/details.js`**: Right sidebar component showing render metadata (AI title, description, files, download/delete buttons)
- **`ui/components/details/details.hbs`**: Details panel template
- **`ui/components/details/details.css`**: Right sidebar styling with smooth slide-in animation

**Updated Components**:
- **`ui/components/sidebar/sidebar.js`**: Added `loadRenders()` to fetch & display renders in grid
- **`ui/components/sidebar/sidebar.css`**: Added 2-column thumbnail grid with status badges and hover effects
- **`ui/components/layout/layout.js`**: Import and initialize details component
- **`ui/components/layout/layout.hbs`**: Added `<div class="__details"></div>` to layout
- **`ui/components/layout/layout.css`**: Updated for 3-column layout (sidebar | renderbox | details)
- **`ui/components/renderbox/renderbox.js`**: Removed delete/download handlers (moved to details), updated event dispatching
- **`ui/components/renderbox/renderbox.hbs`**: Removed delete/download buttons from metadata panel

**Backend Updates**:
- **`backend/builting-main/renders.mjs`**: Enhanced `deleteRender()` with S3 cleanup function
  - Deletes source files from `builting-data` bucket
  - Deletes IFC from `builting-ifc` bucket
  - Deletes DynamoDB record
  - Handles pagination for large file sets
- **`backend/builting-main/index.mjs`**: Already had CORS headers configured

**Event Integration**:
- `renderSelected`: Sidebar dispatches when render clicked, details/renderbox listen
- `rendersUpdated`: Details/renderbox dispatch after delete/complete, sidebar listens and refreshes
- `newRenderRequested`: Controls dispatch, renderbox/details listen to reset UI

**Current Status**:
- Frontend CRUD fully implemented and tested locally
- builting-main.zip (4.5MB) created and ready for deployment
- CORS configuration verified in API Gateway (OPTIONS handlers present for all endpoints)
- Issue: Preflight OPTIONS requests failing - may require API GW CORS settings

### Circular Event Dispatch Error (2026-02-13)

**Problem**: When clicking a render in sidebar, console shows `GET /api/renders/undefined` 404 error

**Root Cause**: Renderbox component was both listening to AND dispatching the `renderSelected` event:
1. Sidebar dispatches `renderSelected` with `{ detail: { id: renderId } }`
2. Renderbox listener (line 371-373) processes it: `await this._handleRenderSelected(e.detail.id);`
3. After loading render, renderbox dispatches `renderSelected` with `{ detail: { render } }` (line 201-203)
4. **This triggers the same listener again** but now `e.detail.id = undefined`
5. Result: `rendersService.getRender(undefined)` calls API with `?userId=user-1` producing 404

**Solution**: Added guard clause in renderbox listener to only process events with `e.detail.id`:

```javascript
// ui/components/renderbox/renderbox.js line 371-374
document.addEventListener('renderSelected', async (e) => {
    // Guard against renderbox's own renderSelected dispatch
    if (e.detail.id) {
        await this._handleRenderSelected(e.detail.id);
    }
});
```

**How It Works**:
- Sidebar dispatches `{ detail: { id } }` → listener processes ✓
- Renderbox dispatches `{ detail: { render } }` → listener skips (guard blocks) ✓
- Details component still receives the dispatch with `{ detail: { render } }` and displays it ✓

**Updated File**: `ui/components/renderbox/renderbox.js` (line 371-374)

### CORS Preflight Error (2026-02-13)

**Problem**: Frontend fetch requests fail with CORS error: `Response to preflight request doesn't pass access control check`

**Solution**: Configured API Gateway CORS:
- AWS API Gateway Console → builting-api
- For each resource (/api/renders, /api/renders/{id}, /api/renders/{id}/download):
  - Select resource → Actions → Enable CORS and replace CORS headers
  - Headers: `Content-Type,Authorization,Cookie`
  - Methods: `OPTIONS,GET,POST,DELETE`
  - Origin: `*`
- Deploy API to `dev` stage

**Status**: ✅ FIXED - CORS now working, render selection working after above circular dispatch fix

---

## 🏗️ AWS Pipeline Architecture

### **S3 Trigger Flow (Auto-Triggered)**
```
1. User uploads files + text description (frontend)
   ├─ Files → S3:builting-data/{userId}/{renderId}/
   └─ Description (if provided) → S3:builting-data/{userId}/{renderId}/description.txt

2. S3:builting-data object created → S3 Event → SNS Topic (builting-render-triggers)

3. SNS → Lambda:builting-orchestrator-trigger (invokes Step Function)

4. Step Function:builting-render-state-machine
   ├─ Task 1: ReadRenderMetadata (get render record from DynamoDB)
   ├─ Task 2: BedrocInvokeIFC (call Bedrock to generate IFC)
   ├─ Task 3: StoreIFC (upload to S3:builting-ifc)
   ├─ Task 4: UpdateDynamoDB (set status to 'completed', store S3 path)
   └─ Error Handling: Retry logic, fallback to failed status

5. Frontend polls GET /renders/{renderId} for status updates
   └─ When status='completed', fetch IFC from builting-ifc bucket
```

### **AWS Resources Required**
| Resource | Name | Purpose |
|----------|------|---------|
| **Lambda** | builting-orchestrator-trigger | Receives S3/SNS event, invokes Step Function |
| **Lambda** | builting-bedrock-ifc | Calls Bedrock API to generate IFC from files |
| **Step Functions** | builting-render-state-machine | Orchestrates render workflow |
| **SNS Topic** | builting-render-triggers | Listens for S3 events, triggers Lambda |
| **S3 Event** | builting-data bucket | Configured to send events to SNS on object creation |
| **DynamoDB** | builting-renders table | Track render status (pending → processing → completed/failed) |

### **DynamoDB Render Record Schema**
```json
{
  "user_id": "user-123",
  "render_id": "ace6e6a1-9f3c-4f99-be19-13128e12ffeb",
  "status": "pending|processing|completed|failed",
  "created_at": 1708990000,
  "source_files": ["file1.pdf", "file2.dwg", "description.txt"],
  "s3_path": "s3://builting-data/user-123/render-id/",
  "ifc_s3_path": "s3://builting-ifc/user-123/render-id/output.ifc",
  "description": "User's description text",
  "ai_generated_title": "Office Layout 3D",
  "ai_generated_description": "Generated IFC model...",
  "error_message": null,
  "orchestration_started": true
}
```

**IMPORTANT**: DynamoDB keys use `user_id` and `render_id` (snake_case with underscores), NOT camelCase.

### **Text Description Handling**
- If user types in renderbox input → convert to `description.txt` and upload to S3 with files
- Store plaintext in DynamoDB `description` field for quick access
- Bedrock pipeline reads all files from S3 folder (including description.txt)

---

## 🔄 Implementation Phases

### **Phase 1: Core Pipeline Setup** (START HERE)
1. Update builting-main Lambda to save plaintext description as .txt file before S3 upload
2. Create S3 event configuration to trigger SNS
3. Create SNS topic (builting-render-triggers)
4. Create builting-orchestrator-trigger Lambda
5. Create Step Function with basic workflow

### **Phase 2: Bedrock Integration**
1. Create builting-bedrock-ifc Lambda (calls Bedrock API)
2. Integrate with Step Function
3. Add error handling & retry logic

### **Phase 3: Frontend Polling**
1. Add `GET /renders/{renderId}/status` endpoint in builting-main
2. Implement frontend polling with loading spinner in renderbox
3. Replace alert popups with in-UI feedback

### **Phase 4: CRUD & User Scoping**
1. Finalize render CRUD operations
2. Add user-scoped access controls
3. Implement delete render (cascades to S3 cleanup)

### **Phase 5: Reach Goals**
1. Human-in-the-loop approval in Step Function
2. Edit/retry failed renders
3. Monitoring & logging improvements

---

## 🚀 Lambda Deployment Instructions

Each Lambda function has its own directory with `index.mjs` and `package.json`. To deploy:

### **Step 1: Install Dependencies**
For each Lambda directory (`builting-read-metadata`, `builting-bedrock-ifc`, `builting-store-ifc`, `builting-orchestrator-trigger`):
```bash
cd backend/[FUNCTION_NAME]
npm install --omit=dev
```

### **Step 2: Create Deployment Zip**
```bash
# Windows/Mac/Linux
zip -r function.zip index.mjs node_modules/
```

### **Step 3: Deploy to Lambda**
1. Open AWS Lambda console
2. Create/Update function with name (e.g., `builting-read-metadata`)
3. Upload zip file
4. Set **Handler**: `index.handler`
5. Set **Runtime**: Node.js 20.x
6. Set **Architecture**: x86_64 (or arm64 if preferred)
7. Set **Timeout**: 300 seconds (5 minutes)
8. Attach IAM role: `builting-lambda-execution-role` with policies:
   - AmazonDynamoDBFullAccess
   - AmazonS3FullAccess
   - CloudWatchLogsFullAccess
   - AmazonBedrockFullAccess (for bedrock-ifc only)

### **Step 4: Configure Environment Variables**
For `builting-orchestrator-trigger`:
- `STATE_MACHINE_ARN`: Set to Step Function ARN (e.g., `arn:aws:states:us-east-1:ACCOUNT:stateMachine:builting-render-state-machine`)

### **Step 5: Update builting-main Lambda**
Upload updated `builting-main.zip` to Lambda function `builting-main`

### **Step 6: Configure S3 → SNS → Lambda**
1. Open S3 bucket `builting-data` properties
2. Go to **Event notifications**
3. Create new notification:
   - Event type: `s3:ObjectCreated:*`
   - Prefix: `uploads/`
   - Destination: SNS topic `builting-render-triggers`
4. In SNS topic, add subscription: Lambda → `builting-orchestrator-trigger`

### **Step 7: Update Step Function**
Create or update Step Function `builting-render-state-machine` with correct Lambda ARNs in state machine definition.

---

## 🚀 IFCBEAM Deployment Guide (2026-02-18)

### What Changed
- Lambda now generates **IFCBEAM** (fully supported by xeokit) instead of IFCSLAB
- Tested locally with Docker - IFCBEAM entity confirmed in output
- Complete spatial hierarchy: PROJECT → SITE → BUILDING → STOREY → **BEAM**

### Deployment Files
- **`builting-json-to-ifc-layer.zip`** (57MB) - Contains ifcopenshell + dependencies
- **`builting-bedrock-ifc.zip`** (1.8KB) - Contains lambda_function.py

Both files are in: `/Users/nainicorn/Documents/text-to-3D/backend/builting-json-to-ifc-python/`

### Step-by-Step Deployment

#### Step 1: Create/Upload Lambda Layer
```bash
# In AWS Lambda Console → Layers → Create layer
# Name: builting-json-to-ifc-layer
# Runtime: Python 3.11
# Upload: builting-json-to-ifc-layer.zip
# Confirm the layer version ARN (you'll need this)
```

#### Step 2: Create/Update Lambda Function
```bash
# Option A: Create new function (if not exists)
# - Name: builting-json-to-ifc
# - Runtime: Python 3.11
# - Handler: lambda_function.handler
# - Timeout: 300 seconds (5 minutes)
# - Memory: 3008 MB (needs enough for large file processing)

# Option B: Update existing function
# - Upload: builting-bedrock-ifc.zip
# - Under "Code" section, upload the zip file

# Either way: Add the layer
# - In Lambda function page → Layers → Add a layer
# - Select: builting-json-to-ifc-layer (version you just created)
```

#### Step 3: Update Step Function
If using Step Functions, update the state machine definition to call `builting-json-to-ifc`:
```json
{
  "Type": "Task",
  "Resource": "arn:aws:lambda:us-east-1:ACCOUNT:function:builting-json-to-ifc",
  "ResultPath": "$.ifcGenerationResult",
  "Next": "StoreIFC"
}
```

#### Step 4: Test
```bash
# Use AWS Lambda Test feature with input:
{
  "buildingSpec": {
    "buildingName": "Test Building",
    "dimensions": {
      "length_m": 200,
      "width_m": 15,
      "height_m": 6
    }
  },
  "renderId": "test-render-001"
}

# Check CloudWatch logs for success and verify:
# ✓ IFC generated successfully
# ✓ IFCBEAM entity found
```

#### Step 5: End-to-End Test
1. Create new render with sample files
2. Monitor Step Function execution
3. Check that render completes with status 'completed'
4. Frontend should load IFC in xeokit viewer
5. Verify geometry displays (was previously blank)

---

**Refer to this file when implementing each phase and making updates**

challenges: changed approach from json to ifc instead of raw to ifc