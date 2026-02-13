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

**✅ COMPLETED**:
- File upload to S3 (builting-data bucket) with description.txt
- Frontend file staging UI with horizontal scroll
- User authentication & DynamoDB tables (builting-users, builting-renders)
- Renders CRUD endpoints (GET /api/renders, GET /api/renders/{renderId}, DELETE /api/renders/{renderId})
- Frontend polling with exponential backoff (2s→5s→10s, 10min timeout)
- rendersService.js and uploadService.js with description support
- Renderbox loading UI with spinner and status messages
- All 4 Lambda functions with correct DynamoDB key schema (user_id, render_id)
- **[2026-02-13] Complete Frontend CRUD Implementation**:
  - ✅ Details sidebar component (right panel) showing render metadata, files, download & delete buttons
  - ✅ Sidebar thumbnail grid (left panel) with 2-column layout showing all user renders
  - ✅ Status badges (pending=gray, processing=blue, completed=green, failed=red)
  - ✅ Event-based communication system (renderSelected, rendersUpdated, newRenderRequested)
  - ✅ Backend delete with complete S3 cleanup (source files + IFC + DynamoDB record)
  - ✅ Layout restructuring (3-column: sidebar | renderbox | details) with smooth animations
  - ✅ builting-main.zip created (4.5MB) with S3 cleanup code ready to deploy

**🚧 IN PROGRESS**:
- Bedrock AI title/description generation in builting-bedrock-ifc Lambda
- Lambda function testing and Step Function orchestration
- Deploy builting-main.zip to AWS Lambda with S3 cleanup code

**📋 REMAINING WORK**:
- Deploy builting-main.zip to AWS Lambda (with S3 cleanup for deletes)
- Implement Bedrock AI title/description generation in builting-bedrock-ifc/index.mjs
- Configure S3 event notifications to SNS
- Deploy Step Function orchestration
- Test complete end-to-end pipeline (create → process → display → delete)
- Error handling & retry logic improvements
- Reach goals (human-in-the-loop, edit renders, real-time updates, IFC previews)

---

## 🐛 Recent Fixes

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

**Refer to this file when implementing each phase and making updates**
