# Text-to-3D Project Status & Architecture

**Project Status**: auth complete, remaining: renders CRUD, renderbox UI completion, AI pipeline completion

---

## 📋 Project Overview

A full-stack application for converting text descriptions + files into 3D IFC files using AWS Bedrock Lambda. Users can create renders (upload files + plaintext description) and view previously generated 3D models.

**Core Flow**: User login → View renders in sidebar → Create new render (upload files + text) or view/delete existing renders → See 3D IFC in renderbox

**Current Setup**:
- Lambda: builting-main (auth + renders CRUD)
- DynamoDB: builting-users table
- API Gateway: builting-api
- Planned: builting-orchestrator Lambda, builting-renders table, S3 buckets (builting-data and builting-ifc)

**Tech Stack**:
- **Frontend**: Vite + Vanilla JavaScript + Handlebars templates
- **Backend**: AWS API Gateway + Lambda + DynamoDB + S3
- **3D Processing**: Bedrock Lambda + AWS Step Functions
- **Viewer**: web-ifc + Three.js

---

## ⚡ QUICK STATUS (Update this section regularly)

**Current Phase**: PHASE 2-4 (Backend + Frontend - CODE COMPLETE, DEPLOYMENT PENDING)

**What's Done**:
- ✅ Frontend: Auth UI, layouts, services structure, file preview, description input, submit flow
- ✅ Backend: builting-main Lambda with auth + users + renders CRUD endpoints
- ✅ API Gateway: CORS enabled on `/api/{type}`
- ✅ DynamoDB: builting-users table + queries, renders schema defined
- ✅ Frontend API: rendersapi.js fully integrated with all endpoints
- ✅ Renderbox: File staging, preview, description input, "Start Render" button
- ✅ Renders List: Sidebar population from backend, delete functionality
- ✅ Render View: IFC viewer integration, metadata display, download button
- ✅ Lambda renders handler: renders.mjs with all CRUD + S3 presigned URLs

**Current Work**:
- 🔄 PHASE 1: Create AWS resources (S3 buckets, DynamoDB table, IAM permissions)
- 🔄 PHASE 1: Deploy builting-main Lambda to AWS (package and upload .zip)

**Next Immediate (After Deployment)**:
1. Test full end-to-end file upload flow (file staging → S3 upload → DynamoDB record)
2. Verify render list populates from backend
3. Test render deletion
4. PHASE 5: Bedrock pipeline integration (Step Functions + Bedrock API calls)

**Files to Deploy**:
- `/Users/nainicorn/Documents/text-to-3D/src/builting-main/` directory
- Commands:
  ```bash
  cd src/builting-main
  npm install
  zip -r builting-main.zip .
  # Upload builting-main.zip to Lambda via AWS Console
  ```

**Key Files Modified**:
- Backend: `src/builting-main/renders.mjs` (NEW - complete CRUD handler)
- Backend: `src/builting-main/index.mjs` (UPDATED - added renders route)
- Backend: `src/builting-main/package.json` (UPDATED - added S3 dependencies)
- Frontend: `src/components/renderbox/renderbox.hbs` (UPDATED - file preview + description input)
- Frontend: `src/components/renderbox/renderbox.js` (UPDATED - file staging + submit flow)
- Frontend: `src/components/renders/renders.hbs` (UPDATED - added delete button)
- Frontend: `src/components/renders/renders.js` (UPDATED - API integration + delete handler)
- Frontend: `src/services/rendersapi.js` (UPDATED - description parameter)

---

## ✅ Completed Work

### Frontend Architecture
- ✅ Vite build setup with SSL support
- ✅ Login/Signup component with email validation
- ✅ Authentication service (login, signup, isAuthenticated, logout)
- ✅ Cookie-based session management (builting-user)
- ✅ User store (client-side state management)
- ✅ Main layout with sidebar, header, and renderbox components
- ✅ Controls component for file upload UI
- ✅ AWS service for API routing with base URL selection (dev/prod)

### Backend API Setup
- ✅ API Gateway configured (dev endpoint: `https://0mc6awox4i.execute-api.us-east-1.amazonaws.com/dev`)
- ✅ Lambda function (builting-main) set up for auth + renders
- ✅ DynamoDB table (builting-users) created with user authentication
- ✅ Basic authentication endpoints (`/api/auth` - login/signup)
- ⏳ DynamoDB table (builting-renders) - needs to be created
- ⏳ S3 buckets (builting-data, builting-ifc) - needs to be created
- ⏳ Lambda function (builting-orchestrator) - future pipeline handler

### File Upload & Processing
- ✅ Rendersapi service with presigned S3 URL generation (with description parameter)
- ✅ S3 upload endpoint with PUT method via presigned URLs
- ✅ Render creation and polling logic
- ✅ S3 bucket structure for uploads and generated IFC files
- ✅ AWS Step Functions pipeline setup (ready to integrate)
- ✅ File staging UI with preview before upload
- ✅ Description input field for user prompts
- ✅ "Start Render" submit button with file collection

### Render Management (CRUD)
- ✅ Lambda render CRUD handler (renders.mjs)
- ✅ POST /api/renders - Create render with presigned S3 URLs
- ✅ GET /api/renders - List user's renders
- ✅ GET /api/renders/{id} - Get single render details
- ✅ DELETE /api/renders/{id} - Delete render with S3 cleanup
- ✅ POST /api/renders/{id}/process - Trigger processing (skeleton)
- ✅ GET /api/renders/{id}/download - Presigned download URL for IFC
- ✅ Renders sidebar list populated from backend
- ✅ Delete button with confirmation on render items
- ✅ Render metadata display (title, description, source files)

### 3D Viewing
- ✅ IFC viewer component using xeokit-sdk
- ✅ web-ifc library for IFC file parsing
- ✅ Three.js integration for rendering
- ✅ Download IFC file functionality
- ✅ Metadata sidebar with render details and source files list

---

## 🔴 Known Issues

### 1. **AWS Resources Not Created**
- **Status**: BLOCKING - Required before deployment
- **Problem**: S3 buckets (builting-data, builting-ifc), DynamoDB table (builting-renders), and IAM permissions need to be created manually in AWS Console
- **Solution**:
  - See PHASE 1 in Priority Task List below for step-by-step AWS Console instructions
  - Update Lambda IAM role with S3 and DynamoDB permissions
- **Priority**: CRITICAL - blocks all render functionality

### 2. **Lambda Not Deployed**
- **Status**: Code ready, deployment pending
- **Problem**: renders.mjs and updated index.mjs not yet packaged and uploaded to AWS Lambda
- **Solution**:
  - Package: `cd src/builting-main && npm install && zip -r builting-main.zip .`
  - Upload .zip to builting-main Lambda via AWS Console
  - Set environment variables: RENDERS_TABLE=builting-renders
- **Priority**: CRITICAL - blocks all render functionality

---

## 📁 Project Structure

```
text-to-3D/
├── src/
│   ├── main.js                    # App entry point
│   ├── components/
│   │   ├── layout/                # Main layout (sidebar + renderbox)
│   │   ├── login/                 # Login/Signup UI
│   │   ├── header/                # Top navigation
│   │   ├── sidebar/               # Renders list (like punk-app chats)
│   │   ├── controls/              # New render button
│   │   ├── renderbox/             # Main area: upload form or render view
│   │   ├── renders/               # Renders list component
│   │   └── ifc-viewer/            # 3D IFC viewer
│   └── services/
│       ├── aws.js                 # API routing & base URL
│       ├── authenticateService.js # Login/signup logic
│       ├── rendersapi.js          # Render CRUD + S3 uploads
│       ├── cookieService.js       # Cookie management
│       └── userStore.js           # Client-side user state
└── package.json

AWS Backend:
├── API Gateway (/api/{type})
│   ├── /api/auth          (POST) - login, signup
│   ├── /api/renders       (GET, POST, DELETE)
│   ├── /api/renders/{id}  (GET) - render details
|   |__ /api/users         
|   |__ /api/users/{id}    (GET) 
├── Lambda
│   ├── builting-main
│   │   ├── Auth handler (login/signup)
│   │   └── Renders handler (list/create/delete/get renders)
│   └── builting-orchestrator (FUTURE)
│       └── Pipeline orchestrator (Bedrock + IFC generation)
├── DynamoDB
│   ├── builting-users (PK: user_id) - [EXISTS]
│   └── builting-renders (PK: user_id, SK: render_id) - [NEEDS CREATE]
├── S3 Buckets
│   ├── builting-data (raw user uploads)
│   │   └── Path: uploads/{user_id}/{render_id}/*
│   └── builting-ifc (processed IFC outputs)
│       └── Path: {user_id}/{render_id}/output.ifc
└── Step Functions (FUTURE)
    └── 3D Generation Pipeline
        (File upload → Bedrock → IFC generation → S3)
```

---

## 🚀 Priority Task List (UPDATED)

### ✅ PHASE 2-4: Code Implementation (COMPLETE)
- ✅ Backend: Lambda render CRUD handler (renders.mjs)
- ✅ Frontend: Renderbox file staging + description input + submit flow
- ✅ Frontend: Renders list from backend + delete functionality
- ✅ Frontend: Render view with metadata + download button
- ✅ Integration: rendersapi.js fully connected to all endpoints

---

### PHASE 1: Create AWS Resources (BLOCKING - DO FIRST)
**Goal**: Set up infrastructure for render CRUD
**Status**: PENDING - Manual AWS Console setup required

**1. Create S3 Bucket: builting-data**
- AWS Console → S3 → Create bucket
- Bucket name: `builting-data`
- Region: `us-east-1`
- Block all public access: **Uncheck**
- After creation → Permissions → CORS configuration:
  ```json
  [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["PUT", "POST", "GET"],
      "AllowedOrigins": ["http://localhost:5173", "http://localhost:5001", "https://localhost:5001"],
      "ExposeHeaders": ["ETag"]
    }
  ]
  ```

**2. Create S3 Bucket: builting-ifc**
- Same as above, bucket name: `builting-ifc`
- Add same CORS policy

**3. Create DynamoDB Table: builting-renders**
- AWS Console → DynamoDB → Create table
- Table name: `builting-renders`
- Partition key: `user_id` (String)
- Sort key: `render_id` (String)
- Use on-demand pricing

**4. Update Lambda IAM Role**
- AWS Console → Lambda → builting-main → Configuration → Permissions
- Click execution role → Add inline policy:
  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
        "Resource": ["arn:aws:s3:::builting-data/*", "arn:aws:s3:::builting-ifc/*"]
      },
      {
        "Effect": "Allow",
        "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem"],
        "Resource": "arn:aws:dynamodb:us-east-1:*:table/builting-renders"
      }
    ]
  }
  ```

---

### PHASE 2: Deploy Lambda (HIGH PRIORITY)
**Goal**: Upload updated Lambda code with renders handler
**Status**: PENDING - Code ready, needs deployment

**Steps**:
```bash
cd src/builting-main
npm install
zip -r builting-main.zip .
# Upload builting-main.zip to builting-main Lambda via AWS Console
```

**After Upload**:
- Lambda → Configuration → Environment variables
- Add: `RENDERS_TABLE` = `builting-renders`
- Configuration → General configuration → Timeout: 30 seconds

---

### PHASE 3: Test End-to-End Flow
**Goal**: Verify full render creation and management workflow
**Status**: PENDING - After PHASE 1 & 2 complete

**Test Cases**:
1. ✅ Login successful (existing, but verify CORS headers)
2. ⏳ Create render: Click attach → select files → see preview → enter description → click "Start Render"
3. ⏳ Verify render appears in sidebar with "pending" status
4. ⏳ Verify files in S3 at `builting-data/uploads/{user_id}/{render_id}/`
5. ⏳ Verify render record in DynamoDB with correct attributes
6. ⏳ Delete render: Click trash icon → confirm → verify removed from sidebar + S3 + DynamoDB
7. ⏳ Create multiple renders: Verify list shows all user's renders

---

### PHASE 5: Pipeline Integration (LOW PRIORITY - Future)
**Goal**: Connect file upload → Bedrock processing → IFC generation
**Status**: NOT STARTED - Code skeleton ready

**When Ready**:
- Create builting-orchestrator Lambda for Bedrock API calls
- Create Step Functions state machine for pipeline
- Update POST /api/renders/{id}/process to trigger Step Functions
- Implement render status updates (pending → processing → completed/failed)
- Add AI-generated title and description to render metadata

---

## 🔧 Development Notes

### Local Development
```bash
cd text-to-3D
npm install
npm run dev  # Runs on https://localhost:5173
```

### Environment Variables Needed
- API Gateway endpoint URL (in `aws.js` - currently hardcoded)
- AWS region (us-east-1)
- S3 bucket names (uploads, outputs)
- DynamoDB table names

### Testing Authentication
1. Create test user via signup
2. Login with credentials
3. Check browser cookies for "builting-user"
4. Check console for CORS errors

### API Testing
Use REST client (VSCode REST Client extension):
```
POST https://0mc6awox4i.execute-api.us-east-1.amazonaws.com/dev/api/auth
Content-Type: application/json

{
  "action": "login",
  "email": "test@example.com",
  "password": "password123"
}
```

---

## 🎯 Next Immediate Steps

**1. Fix CORS Error** (Currently: In Progress)
   - Enable CORS on `/api/{type}` resource (GET, POST, OPTIONS, DELETE)
   - Redeploy API
   - Test login flow

**2. PHASE 2: Create AWS Resources + Render CRUD**
   - Create DynamoDB builting-renders table (PK: user_id, SK: render_id)
   - Create S3 buckets (builting-data for uploads, builting-ifc for IFC files)
   - Implement CRUD handlers in builting-main Lambda (list, create, get, delete renders)
   - Test with REST client

**3. PHASE 3: Build Renderbox UI**
   - File upload form (title, description, file picker)
   - Render view panel with 3D viewer
   - Metadata sidebar (file list, details)

**4. PHASE 4: User Data Isolation**
   - Validate all Lambda requests filter by user_id
   - Check user owns resource before allowing access

**5. PHASE 5: Pipeline Integration**
   - Create builting-orchestrator Lambda
   - Implement Bedrock + Step Functions workflow

---

## 📚 Reference Files

- **Login Flow**: `src/components/login/login.js` + `src/services/authenticateService.js`
- **API Calls**: `src/services/aws.js` (base fetcher)
- **Render Operations**: `src/services/rendersapi.js` (S3 presigned URLs, polling)
- **Render CRUD Pattern**: `/Users/nainicorn/Documents/punk-app/server/chats_router.py` (adapt to renders)
- **Render Frontend Pattern**: `/Users/nainicorn/Documents/punk-app/ui/src/api/chatsapi.js` (adapt to renders)

---

## 🔍 Troubleshooting

| Issue | Solution |
|-------|----------|
| CORS Error | Check API Gateway CORS settings on `/api/{type}`, redeploy |
| Login fails | Verify builting-users table exists, Lambda role has DynamoDB access |
| Auth cookie not set | Check Lambda returns user object with correct structure |
| Renders not loading | Verify builting-renders table created, user_id filtering in Lambda |
| S3 upload fails | Check bucket names, presigned URL generation, S3 permissions |
| DynamoDB write fails | Check table schema (PK/SK), Lambda IAM role has permissions |

---

## 📝 AWS Resource Checklist

Before starting PHASE 2:
- [ ] builting-renders DynamoDB table created
- [ ] builting-data S3 bucket created
- [ ] builting-ifc S3 bucket created
- [ ] Lambda role has DynamoDB + S3 permissions
- [ ] API Gateway CORS enabled and deployed

---

**Refer to this file when implementing each phase.**
