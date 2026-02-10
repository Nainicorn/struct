# Text-to-3D Project Status & Architecture

**Last Updated**: February 2026
**Current Branch**: main
**Project Status**: Core auth in place, remaining: CORS fix, render CRUD, renderbox UI completion

---

## 📋 Project Overview

A full-stack application for converting text descriptions + files into 3D IFC files using AWS Bedrock Lambda. Users can create renders (upload files + plaintext description) and view previously generated 3D models.

**Core Flow**: User login → View renders in sidebar → Create new render (upload files + text) or view/delete existing renders → See 3D IFC in renderbox

**Current Setup**:
- Lambda: builting-main (auth + renders CRUD)
- DynamoDB: builting-users table
- API Gateway: builting-api
- Planned: builting-orchestrator Lambda, builting-renders table, S3 buckets

**Tech Stack**:
- **Frontend**: Vite + Vanilla JavaScript + Handlebars templates
- **Backend**: AWS API Gateway + Lambda + DynamoDB + S3
- **3D Processing**: Bedrock Lambda + AWS Step Functions
- **Viewer**: web-ifc + Three.js

---

## ⚡ QUICK STATUS (Update this section regularly)

**Current Phase**: PHASE 1 (CORS Fix - IN PROGRESS)

**What's Done**:
- ✅ Frontend: Auth UI, layouts, services structure
- ✅ Backend: builting-main Lambda with auth + users endpoints
- ✅ API Gateway: CORS enabled on `/api/{type}`
- ✅ DynamoDB: builting-users table + queries
- ✅ Frontend API fixes: usersService.js updated to `/api/users/`
- ✅ Lambda deployment: builting-main.zip ready

**Current Work**:
- 🔄 Deploy builting-main.zip to AWS Lambda
- 🔄 Test login flow for CORS errors

**Next Immediate (After CORS Verified)**:
1. PHASE 2: Create AWS resources (builting-renders table, S3 buckets)
2. PHASE 2: Implement render CRUD in Lambda
3. PHASE 3: Build renderbox UI (file upload form)
4. PHASE 4: User data isolation
5. PHASE 5: Bedrock pipeline integration

**Files to Deploy**:
- `/Users/nainicorn/Documents/text-to-3D/builting-main-updated/builting-main.zip` (3.9 KB)

**Key Reference**:
- Render pattern: `/Users/nainicorn/Documents/punk-app/server/chats_router.py` (L33-87)

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
- ✅ Rendersapi service with presigned S3 URL generation
- ✅ S3 upload endpoint with PUT method
- ✅ Render creation and polling logic
- ✅ S3 bucket structure for uploads and generated IFC files
- ✅ AWS Step Functions pipeline setup (ready to integrate)

### 3D Viewing
- ✅ IFC viewer component using xeokit-sdk
- ✅ web-ifc library for IFC file parsing
- ✅ Three.js integration for rendering

---

## 🔴 Known Issues

### 1. **CORS Error on Login**
- **Status**: Blocking
- **Location**: `aws.js` → fetch to API Gateway
- **Problem**: API Gateway not returning proper CORS headers for login request
- **Solution Options**:
  - Enable CORS in API Gateway settings
  - Add CORS headers to Lambda proxy responses
  - Configure API Gateway resource-level CORS
- **Priority**: HIGH - blocks all functionality

### 2. **Render CRUD Not Fully Implemented**
- **Status**: API structure ready, Lambda handlers need completion
- **Required Endpoints** (mapped like punk-app chats):
  - `POST /api/renders` - Create new render (user uploads files + plaintext description)
  - `GET /api/renders` - List user's renders (sidebar display)
  - `GET /api/renders/{renderId}` - Get single render details (title, description, associated files)
  - `DELETE /api/renders/{renderId}` - Delete render
- **Database**: DynamoDB builting-renders table (user_id-based isolation)
- **Pattern Available**: See punk-app chats_router.py for CRUD pattern (adapt to renders)
- **Priority**: HIGH - core feature

### 3. **Renderbox UI Not Integrated**
- **Status**: Component exists, no file upload/viewing logic yet
- **Needed**:
  - File upload form (multiple files + plaintext description)
  - Display render details (title, description, file list)
  - Display 3D IFC viewer (right sidebar metadata panel)
- **Location**: `src/components/renderbox/renderbox.js`
- **Related**: `src/services/rendersapi.js` (presigned URLs, S3 upload logic ready)
- **Priority**: MEDIUM - depends on CORS fix + render CRUD

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
│   └── /api/renders/{id}/download (GET) - presigned IFC URL
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

## 🚀 Priority Task List

### PHASE 1: Fix CORS Error (BLOCKING)
**Goal**: Enable successful login
**Steps**:
1. Check API Gateway CORS settings in AWS Console
2. Enable CORS for `https://localhost:5001` (dev) and production domain
3. Ensure Lambda returns proper CORS headers:
   ```
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
   Access-Control-Allow-Headers: Content-Type, Authorization
   ```
4. Test login in browser - should clear console CORS errors

**Related Files**:
- `src/services/aws.js` - base URL routing
- `src/services/authenticateService.js` - login call
- AWS API Gateway CORS settings

---

### PHASE 2: Complete Render CRUD (HIGH PRIORITY)
**Goal**: Implement render list, create, view, delete (like punk-app chats pattern)

**1. Create AWS Resources**:
- DynamoDB table (builting-renders):
  ```
  PK: user_id
  SK: render_id
  Attributes:
    - title (string)
    - description (string)
    - created_at (timestamp)
    - status (pending/processing/completed)
    - ifc_file_path (S3 path - null until processed)
    - source_files (array of file names/paths)
    - metadata (json)
  ```

- S3 buckets:
  - builting-data (for raw uploads)
  - builting-ifc (for processed IFC files)

**2. Implement in builting-main Lambda**:
- `GET /api/renders` - list user's renders (filter by user_id)
- `POST /api/renders` - create new render + generate presigned URLs
- `GET /api/renders/{id}` - get render details
- `DELETE /api/renders/{id}` - delete render + S3 cleanup

**3. Frontend (rendersapi.js already has structure)**:
- `getRenders()` - fetch user's renders
- `createRender(title, description, files)` - create render + upload files
- `getRender(renderId)` - fetch render details
- `deleteRender(renderId)` - delete render

**Reference**: Punk-app chats_router.py (L33-87 for user_id-based CRUD pattern)

---

### PHASE 3: Build Renderbox UI (MEDIUM PRIORITY)
**Goal**: Create new render form + render view panel with metadata sidebar
**Steps**:
1. Implement new render form:
   - Title & description inputs
   - Multiple file upload field
   - Submit button (calls rendersapi.createRender)
   - Upload progress indicator

2. Implement render view:
   - IFC 3D viewer in main area (using ifc-viewer component)
   - Right sidebar panel showing:
     - Render title
     - Description
     - List of source files (uploaded)
     - All associated files from S3
   - Delete button

3. Handle render states:
   - No render selected → show create form
   - Render selected & not processed → show processing status
   - Render completed → show 3D viewer + metadata

**Related Files**:
- `src/components/renderbox/renderbox.js` (main component)
- `src/services/rendersapi.js` (API calls ready)

---

### PHASE 4: User Data Isolation (MEDIUM PRIORITY)
**Goal**: Ensure each user only sees their renders
**Steps**:
1. Lambda extracts user_id from auth token/cookie in all requests
2. All DynamoDB queries filtered by user_id (PK)
3. Validate user owns render before allowing GET/DELETE
4. Apply IAM policies to restrict user access to own data

---

### PHASE 5: Pipeline Integration (LOW PRIORITY - depends on Phase 3)
**Goal**: Connect file upload → Bedrock processing → IFC generation
**Implementation**:
- builting-main triggers Step Functions on POST /api/renders (sets status: pending)
- builting-orchestrator Lambda is invoked by Step Functions
- Orchestrator calls Bedrock API with files + description
- Generates IFC file → uploads to S3 builting-ifc/
- Updates render status to completed + sets ifc_file_path
- Frontend polls render status via GET /api/renders/{id}

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
