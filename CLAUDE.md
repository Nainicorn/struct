# Text-to-3D Project Status & Architecture

**Constraints**
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
    - DynamoDB has test user listed in the "builting-users" table (password is scrypt-hashed)
    - user is authorized via HMAC-signed tokens (userId.timestamp.hmac) sent as Authorization Bearer header; centralized auth gate in builting-main

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
      - authService: Login/signup and session management; stores token in cookie, user in userStore
      - aws: HTTP wrapper for authenticated API calls to API Gateway with Bearer token auth
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
      - for testing -> id: user-1, email: nkoujala@gmail.com, name: Sreenaina, password: scrypt-hashed (plaintext: Bujji1125$)

    - lambda functions (pipeline order: router → read → extract → transform → generate → store)
      * all lambda functions use builting-role (single shared role with 5 custom least-privilege policies: builting-logs, builting-dynamodb, builting-s3, builting-stepfunctions, builting-bedrock)
      * builting-router has ENV variables: STATE_MACHINE_ARN, SESSION_SECRET, ALLOWED_ORIGINS
      - builting-router (node.js20 and arm64): API gateway router for auth, user data, renders, presigned URLs, and finalize endpoint (starts Step Function directly)
      - builting-read (node.js20 and arm64): retrieves render from DynamoDB and lists uploaded files from S3
      - builting-extract (node.js20 and arm64): downloads files from S3, extracts building specs as CSS v1.0 via Bedrock + VentSim/DXF/XLSX/DOCX parsers + multi-pass Bedrock extraction + enrichment; esbuild-bundled (5.7MB)
      - builting-transform (node.js20 and arm64): consolidated Lambda that runs ValidateCSS → RepairCSS → NormalizeGeometry → MergeWalls → InferOpenings → InferSlabs
      - builting-generate (python3.11 container): CSS-driven IFC4 generation with confidence-based semantic mapping, caching, inline IFC validation, self-healing PROXY_ONLY regeneration, mesh fallback (IfcTriangulatedFaceSet), viewer compatibility scoring
      - builting-store (node.js20 and arm64): updates DynamoDB with IFC path, elementCounts, outputMode, cssHash

    - Step Function
      - builting-state-machine

    - IAM role
      - builting-role (single role for all Lambdas)
         - Custom policies: builting-logs, builting-dynamodb, builting-s3, builting-stepfunctions, builting-bedrock

   - ECR
      - builting-generate

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
                  /finalize
                     POST
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
      - /aws/lambda/builting-router
      - /aws/lambda/builting-read
      - /aws/lambda/builting-extract
      - /aws/lambda/builting-transform
      - /aws/lambda/builting-generate
      - /aws/lambda/builting-store

   - S3 buckets
      - builting-data (raw data user uploads for each user render)
      - builting-ifc (generated ifc file for each user render)

---

## Project Status

### COMPLETED ✅
See `COMPLETED.md` for full implementation history — all phases through end-to-end working pipeline are done.

### Remaining / Reach Goals
1. Human-in-the-loop approval after generation so user can add fixes
2. Edit/retry failed renders
3. Multi-level buildings with ramps and stairs
4. MEP systems visualization (HVAC, plumbing, electrical)
5. Complex curved geometries for tunnels
6. Image/blueprint file support (.png, .jpg) via Bedrock vision
7. Real-time collaboration / multi-user support
8. Render versioning / history

**References**: See DEPLOYMENT_GUIDE_IFC4.md and backend/schemas/builting-css-spec.md