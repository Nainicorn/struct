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
- AWS CLI is configured and available — use `aws` commands to upload Lambda zips, update Lambda code, update Step Functions, configure S3 CORS, etc. directly. Ask user only for things that require console-only actions (IAM policy edits, API Gateway deployments, ECR pushes).

**Pipeline Engineering Principles**
- All pipeline changes must be universal — no render-type-specific hacks in generate. Fix problems upstream in extract/structure/geometry.
- Per-element resilience — never degrade the entire model for one bad element. Proxy individual failures, preserve everything else.
- Keep lambda functions lean — decompose monoliths into focused modules. No single file should exceed ~1,000 lines.
- Z-placement is always storey-relative in generate — auto-detect and normalize, no reliance on placementZIsAbsolute flag.
- Wall endpoint coincidence is a structure-lambda responsibility — walls must share exact endpoints before reaching generate.
- Validation must annotate elements with actionable flags — not just write a report that gets ignored.
- Test every change against multiple render types (tunnel, hospital, office, warehouse) before deploying.

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
      - sensorService: Polls GET /sensors (30s interval, visibility-aware pause), POST /sensors/refresh; provides live sensor readings for active render

- Backend Architecture
    - dynamoDB builting-renders table holds each users renders
      - user_id (String), render_id (String), ai_generated_description, ai_generated_title, created_at, description, ifc_s3_path, s3_path, source_files, status

    - dynamoDB builting-users table holds each users information
      - id (String), created_at, email, name, password
      - for testing -> id: user-1, email: nkoujala@gmail.com, name: Sreenaina, password: scrypt-hashed (plaintext: Bujji1125$)

    - dynamoDB builting-sensors table holds simulated live sensor readings per render
      - render_id (String PK), sensor_id (String SK), element_id, ifc_type, sensor_type, value, unit, status, last_updated

    - lambda functions (pipeline order: router → read → extract → resolve → topology-engine → generate → store)
      * all lambda functions use builting-role (single shared role with 5 custom least-privilege policies: builting-logs, builting-dynamodb, builting-s3, builting-stepfunctions, builting-bedrock)
      * builting-router has ENV variables: STATE_MACHINE_ARN, SESSION_SECRET, ALLOWED_ORIGINS, SENSORS_TABLE
      - builting-router (node.js20 and arm64): API gateway router for auth, user data, renders, presigned URLs, finalize endpoint (starts Step Function), and sensor endpoints (GET /sensors, POST /sensors/refresh)
      - builting-read (node.js20 and arm64): retrieves render from DynamoDB and lists uploaded files from S3
      - builting-extract (node.js20 and arm64): downloads files from S3, extracts building specs as CSS v1.0 via Bedrock + VentSim/DXF/XLSX/DOCX parsers + multi-pass Bedrock extraction + enrichment; esbuild-bundled (5.8MB); Phase 1 dual-writes claims.json alongside css_raw.json; Phase 9 adds title block extraction, page role classification, coordinate-bearing prompts, spatial layout assembly (DIRECT_2D/ASSEMBLED_2D/ESTIMATED), multi-page PDF (up to 5 pages), scale calibration, vision-to-BuildingSpec bridge for drawing-primary renders, component-based confidence model
      - builting-resolve (node.js20 and arm64): NormalizeClaims + ResolveClaims — reads claims.json, normalizes units/conventions, groups claims by subject identity, resolves field conflicts, assigns canonical IDs, writes normalized_claims.json + canonical_observed.json + resolution_report.json + identity_map.json
      - builting-topology-engine (node.js20 and arm64, 512MB, 120s): Consolidated from builting-structure + builting-geometry + builting-validate. Runs entire structural inference, geometry build, and validation pipeline in single memory context — no S3 serialization. Pipeline: ValidateCSS → RepairCSS → NormalizeGeometry → [TUNNEL] DecomposeTunnelShell → SnapWallEndpoints (tiered 50mm→150mm) → BuildTopology → [BUILDING] MergeWalls → CleanWallAxes → InferOpenings → CreateOpeningRelationships → InferSlabs → DeriveRoofElevation → AlignSlabsToWalls → SnapSlabsToWallBases → GuaranteeBuildingEnvelope → ClampDimensions → BuildPathConnections (with connection angle computation: MITRE/BUTT/TEE) → EquipmentMounting → AnnotateSweepGeometry → CSSValidation → SafetyChecks → ValidateTopology → RunFullModelValidation → v2 Adapter → Write artifacts to S3. Outputs cssS3Key + resolvedS3Key + validationReportS3Key + readinessScore + all validation fields.
      - builting-generate (python3.11 container, 512MB): CSS-driven IFC4 generation with confidence-based semantic mapping, caching, inline IFC validation, self-healing PROXY_ONLY regeneration, mesh fallback (IfcTriangulatedFaceSet), IfcSweptDiskSolid for circular ducts/pipes, IfcCircleHollowProfileDef for hollow profiles, viewer compatibility scoring, tunnel shell report generation, decomposed parent skip logic, v3 BIM semantics (IfcDuctSegment, IfcSpace containment, branch IfcElementAssembly aggregation, IfcMaterialLayerSetUsage), common Psets (Wall/Slab/Door/Window/Column/Beam + ManufacturerTypeInformation), IfcRelConnectsPathElements with mitre/butt/tee angle metadata, Phase 11 glTF (.glb) and OBJ export via trimesh (non-blocking, 30s time-boxed)
      - builting-store (node.js20 and arm64): updates DynamoDB with IFC path, elementCounts, outputMode, cssHash, validation fields (readinessScore, exportReadiness, authoringSuitability, criticalIssueCount, validationWarningCount, validationProxyRatio, validationReportS3Key, generationModeRecommendation, geometryFidelity)
      - builting-sensors (node.js20 and arm64): seeds and refreshes simulated live sensor data per render; maps IFC element types to sensor types (IfcSpace→TEMPERATURE, IfcDuctSegment→AIRFLOW, IfcFan/IfcPump→EQUIPMENT_STATUS, IfcColumn/IfcBeam→STRUCTURAL_LOAD); stores readings in builting-sensors DynamoDB table; max 20 sensors per type per render

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
                     GET (?format=ifc|glb|obj)
                     OPTIONS
                  /report
                     GET
                     OPTIONS
                  /finalize
                     POST
                     OPTIONS
                  /sensors
                     GET
                     OPTIONS
                     /refresh
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
      - /aws/lambda/builting-resolve
      - /aws/lambda/builting-topology-engine
      - /aws/lambda/builting-generate
      - /aws/lambda/builting-store
      - /aws/lambda/builting-sensors

   - S3 buckets
      - builting-data (raw data user uploads for each user render)
      - builting-ifc (generated ifc file for each user render)

---

## Project Status

### COMPLETED ✅
See `COMPLETED.md` for full implementation history — all phases through final gap-closure are done.

### Extra
* Security & Platform Hardening
   - Replace the shared builting-role IAM role with per-function execution roles following least-privilege principles
   - Restrict S3, DynamoDB, and Step Functions access to only required resources
   - Improve operational logging, monitoring, and deployment configuration
   - Perform a security and infrastructure review to ensure production readiness
* Prepare codebase for final delivery:
   - Add clear, layman's-term comments throughout all frontend and backend code (explain *what* and *why*, not just *how*)
   - Remove dead code, unused files, debug logs, and dev-only artifacts (dist/, test IFC files, etc.)
   - Ensure consistent naming, formatting, and file organization
   - Add top-of-file summaries for every Lambda, service, and component explaining its role in plain English
   - Review and clean up .gitignore, environment configs, and deployment scripts
 * Collaborative Model Review (only if user demand justifies it)
   - Support multi-user review sessions within the viewer
   - Allow users to leave comments or annotations on model elements
   - Provide revision comparison tools to analyze changes between generated models
   - Enable collaborative design review workflows

**References**: See DEPLOYMENT_GUIDE_IFC4.md, backend/schemas/builting-css-spec.md