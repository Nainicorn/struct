# Completed Implementation History

All completed features and fixes listed in chronological order (oldest → newest).

---

## 1. Initial Project Setup & Deployment

### AWS Infrastructure
- API Gateway (`builting-api`) created with full REST resource structure
- DynamoDB tables: `builting-users` (id, email, name, password, created_at) and `builting-renders` (user_id, render_id, status, s3_path, ifc_s3_path, source_files, etc.)
- S3 buckets: `builting-data` (raw uploads) and `builting-ifc` (generated IFC files)
- Step Function (`builting-state-machine`) orchestrating the render pipeline
- CloudWatch log groups for all Lambda functions
- CORS configured in API Gateway (OPTIONS on all endpoints)
- Test user in DynamoDB: id=user-1, email=nkoujala@gmail.com, name=Sreenaina

### Lambda Functions — Initial Versions
- `builting-router` (Node.js 20, arm64): API Gateway request router
- `builting-read` (Node.js 20, arm64): reads render metadata from DynamoDB + lists S3 files
- `builting-extract` (Node.js 20, arm64): downloads files from S3 and extracts building specs
- `builting-transform` (Node.js 20, arm64): validates and transforms CSS data
- `builting-generate` (Python 3.11 container, arm64): generates IFC files from CSS
- `builting-store` (Node.js 20, arm64): updates DynamoDB with results (completed/failed)

### Frontend — Core UI Components
- **login**: Login/signup form with email/password validation, calls authService
- **layout**: Main app container initializing header, sidebar, renderbox, details components
- **header**: Top nav bar with user name display, logout button, sidebar toggle
- **sidebar**: Displays previous renders as clickable cards sorted by creation date (newest first)
- **controls**: "New render +" button that dispatches `newRenderRequested` event
- **renderbox**: Main workspace with file upload UI, render processing display, 3D viewer
- **details**: Side panel showing render metadata (title, description, source files, delete action)
- **ifc-viewer**: 3D viewer using xeokit SDK + web-ifc WASM for IFC model rendering

### Frontend — Services
- `authService.js`: Login/signup, session management, cookie-based auth
- `aws.js`: HTTP wrapper for authenticated API Gateway calls
- `cookieService.js`: Low-level cookie operations (set, get, delete)
- `rendersService.js`: Render CRUD (list, get, delete, download IFC, download source files)
- `uploadService.js`: Presigned URL requests, S3 direct uploads, render finalization
- `usersService.js`: Fetch current user data from backend
- `userStore.js`: Client-side state manager (memory + localStorage backup)
- `modalService.js`: Confirm/alert modal dialogs with backdrop dismiss

### Frontend — Framework & Build
- `messages.js`: BroadcastChannel-based message bus for inter-component communication
- `main.js`: Entry point routing to login or layout based on auth status
- Vite build config with custom HBS loader plugin and WASM setup plugin (port 5001)
- Handlebars templating for all components (.hbs files)
- Global styles, material design variables

### DynamoDB Schema
- `builting-users`: id (String PK), created_at, email, name, password (scrypt-hashed)
- `builting-renders`: user_id (String PK), render_id (String SK), ai_generated_description, ai_generated_title, created_at, description, ifc_s3_path, s3_path, source_files, status

---

## 2. Bedrock Integration & IFC Pipeline Fixes
- Fixed DynamoDB key schema for renders table
- Implemented complete Bedrock IFC pipeline
- Fixed Bedrock model: switched to Claude 3 Sonnet v1 (on-demand supported)
- Enhanced Python Lambda for complete file-to-IFC pipeline
- Fixed IFC visualization: generate IFCBEAM instead of IFCSLAB for beam elements
- Fixed frontend bugs (upload flow, render display)
- Fixed CORS issues in API Gateway

---

## 3. IFC4 Generator (2025-02-19)
- Full IFC4 schema support with materials, property sets, building-type geometry
- Docker image for Python Lambda (arm64) deployed to ECR (`builting-generate`)
- Confidence-based semantic mapping: CSS element type → IFC entity
- Three output modes:
  - `FULL_SEMANTIC` (confidence >= 0.7): proper IFC entities (IfcWall, IfcSlab, etc.)
  - `HYBRID` (0.5-0.7): mix of entities + proxies
  - `PROXY_ONLY` (< 0.5): all IfcBuildingElementProxy with mesh fallback
- Three geometry methods: EXTRUSION (IfcExtrudedAreaSolid), SWEEP (IfcSweptAreaSolid), MESH (IfcTriangulatedFaceSet)
- Building hierarchy: Site → Building → Storey → Spaces → Elements
- Material library: predefined colors for concrete, brick, steel, timber, glass, etc.
- Self-healing: if semantic generation fails, falls back to PROXY_ONLY + mesh
- SHA-256 CSS content hash caching to avoid regeneration

---

## 4. VentSim Tunnel Parser (2025-02-19)
- Custom parser for VentSim 6.0.4 format files
- MAIN section parsing with 69 branches, fans, named spaces
- K-factor (friction coefficient) extraction
- Geometry extraction: position, cross-section, height
- Outputs CSS elements with type `TUNNEL_SEGMENT` and confidence scores

---

## 5. CSS Pipeline Overhaul (2026-02-28)
- CSS v1.0 schema definition and specification
- Upload finalization flow (presigned URLs → S3 upload → finalize endpoint → Step Function)
- Consolidated CSS pipeline Lambda (`builting-transform`) combining 6 validation/repair steps
- Simplified Step Function: read → extract → transform → generate → store
- CSS v1.0 spec documented in `backend/schemas/builting-transform-spec.md`

---

## 6. VentSim Geometry Bug Fixes (2026-02-28)
- Fixed extrusion direction, refDirection, coordinate normalization, header parsing
- Tunnel now renders as correct flat network in viewer

---

## 7. IFC Placement/Storey/Validator Overhaul (2026-03-02)
- Fixed placement chain (Building→Site), storey elevation logic
- Conditional Z subtraction with `placementZIsAbsolute` flag
- Axis/refDirection sanitization
- Changed to IfcWall (not IfcWallStandardCase) for broader compatibility
- Validator excludes spatial containers, improved bounding box with profile bounds
- 8 CSS v1.0 regression tests

---

## 8. DXF Geometry Support (2026-03-03)
- New parser: `parsers/dxfParser.mjs` (~300 lines) — DXF→CSS v1.0 conversion
- Extracts ENTITIES, POLYLINE, ARC, CIRCLE, LINE data
- PROXY-first approach with semantic upgrades for WALL/COLUMN/SLAB
- INSERT block expansion with recursion/cycle limits

---

## 9. Multi-pass Bedrock Extraction + Enrichment (2026-03-03)
- `enrichCSS()`: Bedrock-powered CSS enrichment with strict property whitelist
- Multi-pass Bedrock extraction pipeline:
  - Pass 1: Content summary/classification (first 8KB)
  - Pass 2: Geometry extraction (next 8KB)
  - Pass 3: Material/equipment enrichment
- Uses Claude 3.5 Sonnet model via Bedrock API

---

## 10. XLSX/DOCX File Format Support (2026-03-03)
- New parser: `parsers/xlsxParser.mjs` — XLSX text extraction (max 200 rows, 50 cols, 50KB output)
- New parser: `parsers/docxParser.mjs` — DOCX text extraction via unzipper + XML parsing

---

## 11. Testing, CI, Bundling (2026-03-03)
- Vitest setup for `builting-extract` and `builting-transform`
- 34 tests in extract (18 parser + 16 enrichment)
- 8 tests in transform (CSS pipeline validation)
- esbuild bundling for extract: `npm run build` → 5.7MB minified, 1.6MB zip
- GitHub Actions CI pipeline

---

## 12. IFC Quality Improvements (2026-03-03)

### 12A: Wall Alignment + Merging
- `mergeWalls()` in transform pipeline: snaps direction to cardinal axis within 5 deg, merges collinear walls
- Merge criteria: angle < 3 deg, endpoints within 0.05m, same thickness within 10%, same storey
- Provenance tracking: `metadata.mergedFrom` with original element_keys

### 12B: Opening Inference (Doors/Windows)
- `inferOpenings()` in transform pipeline: matches DOOR/WINDOW to nearest WALL on same storey (0.5m threshold)
- Sets `metadata.hostWallKey` on matched openings; unmatched kept as standalone

### 12C: Slab Inference
- `inferSlabs()` in transform pipeline: assigns `properties.slabType` = FLOOR or ROOF based on storey position

### 12D: Mesh Fallback Escalation
- 3-step escalation in `create_element_geometry()`: normal extrusion → sanitized extrusion → IfcTriangulatedFaceSet mesh
- Tracks fallback type in `metadata.geometryFallbacks`

### 12E: Viewer Compatibility Validation
- Enhanced `validate_ifc()`: checks for NaN/Inf directions, large coordinates (>1e6), storey containment, missing Body representation
- `compatibilityScore` (0-100), `meshFallbackCount`, `proxyFallbackCount` in validation report

---

## 13. Backend Hardening Phase 1 — Trust-Boundary Cleanup (2026-03-10)

### IAM Consolidation
- Consolidated 2 roles (`builting-lambda-role`, `builting-lambda-execution-role`) → 1 role (`builting-role`)
- 5 custom least-privilege policies: `builting-logs`, `builting-dynamodb`, `builting-s3`, `builting-stepfunctions`, `builting-bedrock`
- All Lambdas updated to use `builting-role`

### Auth Hardening (auth.mjs)
- Password hashing with `crypto.scrypt` (FIPS-compatible, zero dependencies)
- HMAC-signed tokens: `userId.timestamp.hmac` format using `SESSION_SECRET` env var
- `verifyToken()` with timing-safe comparison (`crypto.timingSafeEqual`)
- `getUserIdFromCookies()` checks `Authorization: Bearer <token>` header first, falls back to cookie

### Centralized Auth Gate (builting-router/index.mjs)
- OPTIONS preflight always passes (no auth)
- `/api/auth` POST is public (no auth)
- All other routes require valid token → sets `event._authenticatedUserId`
- CORS validated against `ALLOWED_ORIGINS` env var, no wildcard fallback

### User Access Control (users.mjs)
- Self-only access enforcement: `requestedId !== event._authenticatedUserId` → 401

### Render Auth (renders.mjs)
- Uses `event._authenticatedUserId` instead of `queryStringParameters.userId`
- Prevents cross-user render access

### Upload Validation (uploads.mjs)
- Uses `event._authenticatedUserId` instead of request body userId
- Extension allowlist: `.txt`, `.pdf`, `.xlsx`, `.xls`, `.docx`, `.dxf`
- Path traversal, control char, filename length (255), file count (20) checks

### Frontend Auth Updates
- `authService.js`: stores token in cookie (24h expiry) + user in `userStore`; clears both on logout
- `usersService.js`: uses `userStore`/localStorage first, falls back to GET `/api/auth` validation
- `aws.js`: sends `Authorization: Bearer <token>` header (cross-origin cookies don't work)
- `rendersService.js`: removed `?userId=` query params from all endpoints
- `uploadService.js`: removed `userId` from POST body

---

## 14. Backend Hardening Phase 2 — Render Lifecycle (2026-03-10)
- `renders.mjs`: `createRender()` sets initial status to `uploading` (was `pending`)
- `renders.mjs`: `finalizeRender()` uses DynamoDB conditional update (`ConditionExpression: status = uploading`) for idempotency — prevents duplicate Step Function executions
- `renders.mjs`: `finalizeRender()` fails fast with 500 if `STATE_MACHINE_ARN` not set
- Status lifecycle model: `uploading` → `processing` → `completed`/`failed`

---

## 15. Backend Hardening Phase 3 — Env Var Portability (2026-03-10)
- All Lambdas: removed `{ region: 'us-east-1' }` from AWS SDK clients (runtime provides `AWS_REGION`)
- All Lambdas: hardcoded bucket/table names → `process.env.X || 'default'` pattern
- Env vars per Lambda:
  - `builting-router`: `SESSION_SECRET`, `USERS_TABLE`, `RENDERS_TABLE`, `DATA_BUCKET`, `IFC_BUCKET`, `STATE_MACHINE_ARN`, `ALLOWED_ORIGINS`
  - `builting-read`: `RENDERS_TABLE`
  - `builting-store`: `RENDERS_TABLE`, `IFC_BUCKET`
  - `builting-generate`: `DATA_BUCKET`, `IFC_BUCKET` (Python)
- `ui/services/aws.js`: API Gateway URL moved to `API_BASE_URL` constant
- Fixed `renders.mjs` self-referencing bug: `DATA_BUCKET = process.env.DATA_BUCKET || DATA_BUCKET` → `|| 'builting-data'`
- Fixed `users.mjs` missing env var: hardcoded `'builting-users'` → `process.env.USERS_TABLE || 'builting-users'`
- Fixed `lambda_function.py` last remaining hardcoded `bucket = 'builting-ifc'` → `bucket = IFC_BUCKET`
- All 5 Node.js Lambda zips rebuilt
- Docker image rebuilt + pushed for `builting-generate`

---

## 16. AWS Console Setup + Bug Fixes (2026-03-10)
- All Lambda zips uploaded to AWS console (builting-router, builting-read, builting-extract, builting-store, builting-transform)
- Docker image deployed for `builting-generate` (arm64, `--provenance=false` to avoid manifest error)
- Lambda timeouts configured: 30s (router/read/store), 60s (transform), 300s (extract/generate)
- API Gateway throttle set: Rate=50, Burst=100
- S3 block public access + encryption verified
- IAM policy updated: added `arn:aws:bedrock:*:*:inference-profile/*` for Bedrock access
- IAM policy updated: state machine ARN corrected to `builting-state-machine`
- Dockerfile fixed: multi-arch micromamba download with `ARG TARGETARCH`

---

## 17. Frontend Bug Fixes & UI Polish (2026-03-10 – 2026-03-11)
- Fixed text-only upload 400 error: empty `fileNames[]` → auto-create `input.txt` Blob from description
- Fixed modal text overflow: `word-break: break-word`, `overflow-wrap: break-word`, `white-space: pre-wrap`, `max-height: 80vh`, `overflow-y: auto`
- Fixed sidebar collapse behavior: `_userCollapsed`/`_autoCollapsed` state tracking in layout.js, `sidebarToggled` event from header.js
- Sidebar render cards with status indicators, relative timestamps, cached thumbnails (localStorage + memory, max 50)
- Sidebar delete button on each render card with confirmation modal
- Details panel: close button, backdrop on mobile (≤1100px), source file download (base64 decode → blob download)
- Renderbox file staging: up to 15 files with extension validation, preview with remove buttons
- Renderbox polling: exponential backoff (2s→5s→10s→15s) for up to 10 minutes
- Renderbox thumbnail capture: multiple attempts (up to 4) to capture canvas snapshot, dispatches `thumbnailCaptured` event
- Renderbox IFC download: base64 → blob conversion, browser download with AI-generated title as filename
- Details panel: clickable source file boxes that download original uploaded files
- Responsive layout with 900px sidebar breakpoint
- End-to-end flow tested and working

---

## 18. Step Function Configuration
- Pipeline order: ReadRenderMetadata → ExtractBuildingSpec → CSSPipeline → GenerateIFC → StoreIFC
- Error handling: any step failure caught and routed to HandleFailure state (marks render as `failed` in DynamoDB)
- Retry policies: 2 retries on read/extract/generate/store, 1 retry on transform
- State machine definition stored in `backend/step-function/current_json.json`

---

## Full Feature Summary

### Frontend Capabilities
- User authentication (login/logout with scrypt-hashed passwords)
- File upload (up to 15 files: .txt, .pdf, .xlsx, .xls, .docx, .dxf)
- Text-only input (auto-converts to .txt file)
- Real-time render status polling with exponential backoff
- 3D IFC model viewing (xeokit + web-ifc WASM)
- Render thumbnail caching for sidebar previews
- Responsive sidebar collapse (user toggle + auto at 900px)
- Download IFC files and source files
- Delete renders with confirmation
- Modal dialogs (confirm/alert)

### Backend Capabilities
- HMAC-signed token auth with timing-safe verification
- Centralized auth gate on all API routes
- Self-only user access control
- File parsing: PDF, XLSX, DOCX, DXF, VentSim, plaintext
- 3-pass Bedrock LLM extraction (classify → geometry → enrich)
- CSS v1.0 intermediate format with validation/repair/normalization
- Wall merging, opening inference, slab inference
- Confidence-based IFC4 generation with 3 output modes
- 3-step geometry fallback (extrusion → sanitized → mesh)
- Self-healing proxy-only regeneration on failure
- Inline IFC validation with compatibility scoring
- Step Function orchestration with retries and error catching
- Render lifecycle: uploading → processing → completed/failed
- Env var portability across all Lambdas
