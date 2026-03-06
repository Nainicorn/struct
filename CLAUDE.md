# Text-to-3D Project Status & Architecture

**Claude Code Constraints**
- update claude.md file everytime you or user finishes a part of the major implementation & when you or user updates code/zip
- everytime a task is complete, remove the context associated with it in the claude.md file and put it into completed.md
- claude.md should only contain main context of project and remaining steps and completed.md should contain everything that has been implemented both in frontend and backend
- ask user before you compact
- when compacting, look at previous chat AND updated.md AND claude.md to get full scope so you don't forget important context
- separate each task into sub-tasks if needed and only after completion, move to the next task (go step by step)
- use plan mode everytime you plan out the next phase or tasks
- when you start working on the backend implementation via AWS suggest any improvements IF necessary
- everytime lambda function updated and user needs to upload new zip file, YOU take care of the zip function

## Project Overview

A full-stack application that focuses on extracting large amounts of raw unstructured building information modeling (BIM) content from plaintext, images, blueprints, sensors, pdfs, etc. and generates a 3D model file (IFC) format to view in either built-in frontend interface via a web ifc viewer OR to download and view in 3D modeling tools such as Revit. The goal is to create a digital twin of a building or structure and all of its functional components. The tech stack includes a no-framework approach by simply using vanilla javascript, html/hbs and css while the backend is all configured through AWS.

## Codebase Overview

The backend folder contains the most recent code or information that is is identical to the current setup of AWS at any given time. This will continue to be updated as the project develops further for better context for Claude Code and user. The ui folder contains all of the components (both structure and style) on the screen and connections to backend; it also uses a ecmascript6+ based folder/file structure. The goal is to keep the codebase extremely clean and easy to understand and navigate. The ifc folder is all the test files used during each current render test.

## Core Flow

- User logins
    - DynamoDB has test user listed in the "builting-users" table
    - user is authorized via cookies in frontend and through API gateway "builting-api" and Lambda logic in "builting-main"

- User has access to their home page which contains header, renderbox, sidebar, etc.
    - User can click logout button in the header and be redirected back to the login screen
    - User can click the sidebar collapse button in the header to collapse the sidebar for more renderbox real-estate
    - User can start new render
        - user can start new render by clicking "new render +" button or at login when showed the default renderbox screen
        - user should be able to upload new files and documents from their computer (.txt, .pdf, .img) and if they type in the renderbox input box the text will be converted automatically into .txt and sent in with the other files
        - the files and documents will be sent into S3 bucket "builting-data" (the S3 bucket and user should be connected properly)
        - a loading state element will appear on the screen until the IFC file is generated in the backend, the frontend will receive it and the ifc viewer in the frontend will render it along with other details like an ai-generated title, description, all of the raw data files from "builting-data" S3 bucket, and a function to download the IFC file
    - User can view old renders which are embedded inside sidebar
        - the old render will be a square shaped element that has the title of the render and the 3d static image preview
        - when the user clicks on an old render, they should be able to see details like an ai-generated title, description, all of the raw data files from "builting-data" S3 bucket, and a function to download the IFC file
        - the ifc file will be retrieved from the S3 bucket "builting-ifc"

- UI Architecture
   - components
      - login: Login/signup form for user authentication
      - layout: Main app container that initializes all child components (header, sidebar, renderbox, details)
      - header: Top navigation bar with user name display, logout button, and sidebar toggle
      - sidebar: Displays user's previous renders as cards and contains "new render" button via controls component
      - controls: "New render" button that triggers the upload interface
      - renderbox: Main workspace for file uploads, render processing display, and active render viewing
      - details: Side panel showing selected render metadata, AI-generated title/description, source files, and download/delete actions
      - ifc-viewer: 3D viewer component using xeokit SDK to display and interact with IFC models
   - main.js: Entry point that routes to login or layout based on authentication status
   - framework
      - messages.js: Message/event handling system
   - services
      - authService: Login/signup and session management (login, signup, isAuthenticated, logout)
      - aws: HTTP wrapper for authenticated API calls to API Gateway with cookie credentials
      - cookieService: Low-level cookie operations (set, get, delete) for session persistence
      - rendersService: Fetch user's renders, get render details, download IFC, delete renders
      - uploadService: Request presigned S3 URLs and upload files/descriptions directly to S3
      - usersService: Fetch current user data and user info from backend
      - userStore: Client-side state manager for current user (session in memory + localStorage backup)

- Backend Architecture
    - dynamoDB builting-renders table holds each users renders
      - user_id (String), render_id (String), ai_generated_description, ai_generated_title, created_at, description, ifc_s3_path, s3_path, source_files, status

    - dynamoDB builting-users table holds each users information
      - id (String), created_at, email, name, password
      - for testing -> id: user-1, email: nkoujala@gmail.com, name: Sreenaina, password: Bujji1125$

    - lambda functions (in execution order)
      * all lambda functions use builting-execution role
      * builting-orchestrator-trigger has ENV variable state-machine ARN
      * builting-main has ENV variable STATE_MACHINE_ARN
      - builting-main (node.js20 and arm64): API gateway router for auth, user data, renders, presigned URLs, and finalize endpoint
      - builting-orchestrator-trigger (node.js20 and arm64): SNS trigger on S3 file upload; checks finalized flag, deduplicates and starts Step Function
      - builting-read-metadata (node.js20 and arm64): retrieves render from DynamoDB and lists uploaded files from S3
      - builting-bedrock-ifc (node.js20 and arm64): downloads files from S3, extracts building specs as CSS v1.0 via Bedrock + VentSim/DXF/XLSX/DOCX parsers + multi-pass Bedrock extraction + enrichment; esbuild-bundled (5.7MB)
      - builting-css-pipeline (node.js20 and arm64): consolidated Lambda that runs ValidateCSS → RepairCSS → NormalizeGeometry → MergeWalls → InferOpenings → InferSlabs
      - builting-json-to-ifc (python3.11 container): CSS-driven IFC4 generation with confidence-based semantic mapping, caching, inline IFC validation, self-healing PROXY_ONLY regeneration, mesh fallback (IfcTriangulatedFaceSet), viewer compatibility scoring
      - builting-store-ifc (node.js20 and arm64): updates DynamoDB with IFC path, elementCounts, outputMode, cssHash

    - Step Function
      - builting-render-state-machine

    - SNS topic
      - builting-render-triggers

    - IAM role
      - builting-lambda-execution-role
         - AmazonBedrockFullAccess, AmazonDynamoDBFullAccess, AmazonS3FullAccess, CloudWatchLogsFullAccess
   
   - ECR
      - builting-json-to-ifc

   - API gateway
      - builting-api
      - structure:
      /
         /api
            /auth
               OPTIONS
               POST
            /renders
               GET
               OPTIONS
               POST
               /{id}
                  DELETE
                  GET
                  OPTIONS
                  /download
                     GET
                     OPTIONS
            /uploads
               /presigned
                  OPTIONS
                  POST
            /users
               OPTIONS
               /{id}
                  GET
                  OPTIONS
   
   - Cloudwatch log groups
      - builting-main
      - builting-bedrock-ifc
      - builting-read-metadata
      - builting-css-pipeline
      - builting-store-ifc
      - builting-json-to-ifc

   - S3 buckets
      - builting-data (raw data user uploads for each user render)
      - builting-ifc (generated ifc file for each user render)

---

## Project Status

### COMPLETED ✅
See `completed.md` for full implementation history.

**Summary of completed work:**
- IFC4 Generator (2025-02-19): full IFC4 schema, materials, property sets, building-type geometry
- VentSim Tunnel Parser (2025-02-19): MAIN section parsing, 69 branches, fans, named spaces
- CSS Pipeline Overhaul Phase 1+4 (2026-02-28): CSS v1.0 schema, upload finalization, confidence-based IFC generation, builting-css-pipeline Lambda, simplified Step Function
- VentSim Geometry Bug Fixes (2026-02-28): fixed extrusion direction, refDirection, coordinate normalization, header parsing → tunnel now renders as correct flat network ✅
- IFC Placement/Storey/Validator Overhaul (2026-03-02): fixed placement chain (Building→Site), storey elevation logic, conditional Z subtraction with `placementZIsAbsolute` flag, axis/refDirection sanitization, IfcWall (not StandardCase), validator excludes spatial containers, improved bbox with profile bounds, 8 CSS v1.0 regression tests ✅

### TO-DO: Manual AWS Setup Required
1. **Update `builting-bedrock-ifc`** → upload `builting-bedrock-ifc.zip` (1.6MB, esbuild-bundled)
2. **Update `builting-css-pipeline`** → upload `builting-css-pipeline.zip` (6.2KB)
3. **Rebuild & push Docker image** for `builting-json-to-ifc` (mesh fallback + viewer validation)
4. **Update `builting-store-ifc`** → `builting-store-ifc.zip` (from previous session)
5. **Update `builting-main`** → `builting-main.zip` (from previous session)
6. **Update `builting-orchestrator-trigger`** → `builting-orchestrator-trigger.zip` (from previous session)
7. **Update Step Function** `builting-render-state-machine` with `backend/step-function/current_json.json`
8. Test end-to-end flow

### Reach Goals
1. Human-in-the-loop approval after generation so add fixes
2. Edit/retry failed renders
3. Multi-level buildings with ramps and stairs
4. MEP systems visualization
5. Complex curved geometries for tunnels

**References**: See DEPLOYMENT_GUIDE_IFC4.md and backend/schemas/css-v1.0.md