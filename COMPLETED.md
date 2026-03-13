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

---

## Pipeline Accuracy Overhaul (Phases A–G)

### builting-extract
- Source file classification: classifySourceFile() → NARRATIVE / TECHNICAL_NARRATIVE / SCHEDULE / SIMULATION / DRAWING
- Priority-sectioned Bedrock prompts: buildPriorityFileContent() with PRIMARY/SECONDARY/TERTIARY caps
- Dedicated tunnel/underground facility extraction path: buildTunnelPass2Prompt()
- Deterministic tunnel CSS generation: buildTunnelCSS() — portals, segments (chainage-based), shafts, equipment
- VentSim + narrative merge: when both present, narrative drives topology; VentSim fans/branches overlaid as semi-transparent DUCT elements
- Building equipment confidence raised 0.65 → 0.75 (above HYBRID threshold)
- Equipment segment_name anchoring within section bounds in buildingSpecToCSS()
- Provenance fields (source, sourceRole, explicitOrInferred) on all elements
- Refinement context injection: CORRECTION/REFINEMENT block prepended as highest priority

### builting-generate
- Added Pset_TunnelSegmentCommon pset for TUNNEL_SEGMENT elements
- Material colors: blasted_rock updated, shotcrete added

### builting-extract (Structure Generation)
- buildGableRoofMesh() — deterministic gabled roof geometry (MESH method)
- Section-based building composition (wings, garages, annexes)
- Secondary vertical features: chimneys, exhaust stacks, vents

---

## Leidos RFP Gap Closure: Traceability + Human-in-the-Loop

### Source Traceability (Deliverable 6)
- buildTracingReport() in builting-extract — groups elements by source file, role, confidence
- tracingReport saved to CSS metadata and returned from extract handler
- Step Function passes tracingReport from specResult to StoreIFC
- builting-store writes tracingReport to DynamoDB
- Details panel "Generation Report" section: outputMode badge, confidence breakdown, per-file rows with role badges

### Human-in-the-Loop Refinement (Stretch B)
- POST /api/renders/{id}/refine endpoint — creates new render reusing original S3 files, starts pipeline
- Refinement text injected as HIGHEST PRIORITY block in Bedrock prompts via buildPriorityFileContent()
- Renderbox refinement input wired: Enter/send when viewing-render state → calls refineRender → polls new renderId
- rendersService.refineRender() added
- Sidebar shows "↩ Refinement" badge on refined render cards

### IFC Element Click Inspection
- ifc-viewer.setupPickEvents() — uses xeokit scene.input.on('mouseclicked') + scene.pick() + metaScene.metaObjects
- Fires elementPicked / elementPickCleared DOM events
- Renderbox element chip: shows IFC type (e.g. "Wall", "Slab") on element click, clears on background click
- _bindPickEvents() in renderbox deduplicates listeners across model reloads

### Zips updated
- builting-extract.zip (1.6MB), builting-store.zip, builting-router.zip

---

## Structure-First IFC Generation — Tunnel Shell Decomposition (2026-03-12)

### Transform Lambda — Tunnel Shell Decomposition
- `decomposeTunnelShell(css)` function added to `builting-transform/index.mjs`
- Decomposes rectangular STRUCTURAL TUNNEL_SEGMENTs into 4-5 shell pieces: LEFT_WALL, RIGHT_WALL, FLOOR slab, ROOF slab, optional VOID space
- Orthonormal frame construction from branch axis + refDirection with parallel-axis fallback
- WALL_THICKNESS = 0.3m default assumption, tracked via `shellThicknessBasis: 'DEFAULT'`
- Guards: duplicate-decomposition (skip if `decompositionMethod`/`derivedFromBranch`/`shellPiece` already present), minimum dimension (W>0.6, H>0.6, depth>0.5), invalid placement, invalid frame, void suppression (inner dims > 0.1m)
- Parent TUNNEL_SEGMENTs immutable (only `element_key` backfill allowed)
- Decomposition is additive in CSS — derived elements appended as batch
- TUNNEL domain guards: `mergeWalls()` and `inferSlabs()` skip for TUNNEL domain
- Pipeline order: ValidateCSS → RepairCSS → NormalizeGeometry → **DecomposeTunnelShell** → MergeWalls → InferOpenings → InferSlabs
- `css.metadata.tunnelDecomposition` stats: decomposedBranchCount, derivedShellPieceCount, skipped counts, method

### Generator Lambda — Shell Mapping + Report
- Decomposed parent skip: collects `derivedFromBranch` set, skips STRUCTURAL TUNNEL_SEGMENTs with matching `element_key`
- Shell pieces map to proper IFC entities: WALL → IfcWall, SLAB → IfcSlab (FLOOR/ROOF PredefinedType), SPACE → IfcSpace
- IfcSlab PredefinedType override: `slabType == 'ROOF'` → `PredefinedType = 'ROOF'`
- Tunnel bbox validation warning: flags vertical span > 3× avg profile height
- `tunnelShellReport` in return payload: structureFirstRatio, wall/slab/space/proxy/duct/equipment counts, defaultedThicknessCount
- Return tuple expanded to 5 values (added `tunnel_shell_report`)

### Deployment
- Transform Lambda: zip created (`builting-transform.zip`), uploaded to AWS
- Generator Lambda: Docker image built (arm64), pushed to ECR (`builting-generate`), Lambda updated

### Design Note
- Structure-first decomposition is domain-extensible — tunnel shell is the first implementation; the same pattern (decompose → derive typed shell pieces → skip parent at IFC emission) can be applied to other structure types (e.g., mine shafts, culverts, retaining walls)
- Buildings/general structures continue using the existing mergeWalls → inferOpenings → inferSlabs path which already produces proper IfcWall/IfcSlab/IfcDoor/IfcWindow entities

### Follow-up Noted
- `builting-store` does NOT persist `tunnelShellReport` to DynamoDB — needs future update

---

## Shell Orientation Fix v2 (2026-03-12)

### Bug
v1 shell decomposition varied `placement.refDirection` per piece type (walls used `up`, slabs used `side`), causing inconsistent local coordinate frames and misaligned extrusions in IFC viewers.

### Fix (Transform Lambda only)
- All derived shell pieces now share ONE stable branch frame: `placement.refDirection = side` for all pieces
- Local frame: Z = tunnel direction, X = side (profile width), Y = up (profile height)
- Thickness-aware offsets: `±(W/2 - t/2)` and `±(H/2 - t/2)` instead of raw `±W/2` / `±H/2`
- Slab width changed from `W` to `W - 2t` to fit between wall inner faces (no corner overlap)
- W and H interpreted as outer structural dimensions (full excavation boundary)
- Generator unchanged — bug was entirely in transform-side shell frame/orientation logic

### Deployment
- Transform Lambda: zip created (`builting-transform.zip`), needs upload to AWS
- Generator Lambda: no rebuild needed

---

## BIM Semantic Structure v3 (2026-03-12)

### Context
After v2 shell orientation fix, IFC had correct geometry (93 IfcWall, 84 IfcSlab, 42 IfcSpace) but lacked BIM semantics: 97 IfcBuildingElementProxy (ducts mapped to proxy), 0 IfcDuctSegment, 1 IfcRelContainedInSpatialStructure, 3 IfcRelAggregates, 0 IfcMaterialLayerSetUsage.

### Changes — Transform Lambda (`builting-transform/index.mjs`)
- **Infrastructure containment hints**: After shell derivation, builds `branchToVoidKey` lookup and links EQUIPMENT elements (with `hostSegmentId`) to their branch's void space via `elem.metadata.hostSpaceKey`
- Only EQUIPMENT elements receive `hostSpaceKey`; ducts/walls/slabs never do
- `infrastructureLinkedCount` added to `tunnelDecomposition` metadata

### Changes — Generator Lambda (`builting-generate/lambda_function.py`)
- **DUCT → IfcDuctSegment**: SEMANTIC_IFC_MAP updated, PIPE → IfcPipeSegment added (forward-compatible)
- **PredefinedType**: IfcDuctSegment/IfcPipeSegment → RIGIDSEGMENT
- **Pset_DuctSegmentCommon**: Shape, NominalDiameter (round) or Width/Height (rectangular)
- **ifc_by_key**: Key-based element lookup (`element_key → IFC entity`) replacing positional iteration
- **IfcSpace containment**: Equipment with `hostSpaceKey` contained by IfcSpace (not storey); mutual exclusivity enforced via `storey_excluded_keys`
- **Branch aggregation**: Shell pieces grouped by `derivedFromBranch` into IfcElementAssembly + IfcRelAggregates; new IfcLocalPlacement per assembly (avoids shared-placement warnings)
- **IfcMaterialLayerSetUsage**: Applied to tunnel shell walls (AXIS2) and slabs (AXIS3) with known `shellThickness_m`; never applied to spaces/ducts/fans/non-tunnel
- **Tunnel shell report**: New v3 metrics — `ductSegmentCount`, `pipeSegmentCount`, `spaceContainmentRelCount`, `branchAssemblyCount`, `materialLayerCount`, `infrastructureInSpaceCount`, `missingSpaceContainmentKeyCount`, `missingBranchAggregationKeyCount`
- **apply_material_layer()**: Helper function for IfcMaterial → IfcMaterialLayer → IfcMaterialLayerSet → IfcMaterialLayerSetUsage → IfcRelAssociatesMaterial chain

### What v2 geometry is preserved
All shell orientation unchanged: stable branch frame (`refDirection = side`), thickness-aware offsets, slab width = W − 2t, outer dimension convention.

### Deployment
- Transform Lambda: zip created (`builting-transform.zip`), uploaded to AWS
- Generator Lambda: Docker build → ECR push → Lambda update completed

---

## 8. v3.1 — Per-Space Containment Fix (2026-03-12)

### Problem
v3 space containment completely failed: IfcRelContainedInSpatialStructure stayed at 1. Root cause: fans' `hostSegmentId` points to DUCT-type branches (not decomposed), not STRUCTURAL branches (which have void spaces). The `branchToVoidKey` lookup always missed.

### Fix — Transform Lambda (`builting-transform/index.mjs`)
- **Replaced** `branchToVoidKey` + `hostSegmentId` matching with finite-segment centerline proximity matching
- Collects eligible VOID elements as centerline segments (origin = branch midpoint, ±depth/2 along axis)
- Matches each EQUIPMENT element to nearest void space by distance to finite centerline segment
- Along-axis sanity guard (2m tolerance), 10m max containment distance
- Epsilon-safe deterministic tie-breaking: dist → |t| → lexical key (null-safe)
- Records metadata: `hostSpaceKey`, `hostVoidSpaceKeyMatched`, `hostStructuralBranchMatched`, `hostSpaceDistance`
- New diagnostic counters: `noVoidAvailableCount`, `invalidVoidCandidateCount`, `voidSpaceCount`
- Geometry invariant: metadata-only, no equipment placement changes

### Generator — Diagnostic Print Only
- Added `v3.1 Space containment:` diagnostic print after space containment loop
- No logic changes — generator containment code was always correct, just never received data

---

## 9. v4 — Tunnel Space Boundary Semantics (2026-03-12)

### Feature
Added IfcRelSpaceBoundary relationships linking each decomposed tunnel branch's VOID IfcSpace to its shell siblings (LEFT_WALL, RIGHT_WALL, FLOOR, ROOF). Semantic-only boundaries — no ConnectionGeometry, no second-level boundaries.

### Changes — Generator Lambda (`builting-generate/lambda_function.py`)
- **`branch_shell_by_piece`**: New per-branch lookup mapping `derivedFromBranch → { shellPiece → ifc_entity }`
- **IfcRelSpaceBoundary creation**: For each branch with valid VOID IfcSpace, creates one boundary per shell sibling (LEFT_WALL, RIGHT_WALL, FLOOR, ROOF only)
- IFC class guards: VOID must resolve to IfcSpace; shell siblings must be IfcWall or IfcSlab
- `PhysicalOrVirtualBoundary='PHYSICAL'`, `InternalOrExternalBoundary='INTERNAL'`
- Counter semantics: `boundedSpaceCount` (complete), `incompleteBoundarySpaceCount` (partial), `invalidVoidSpaceClassCount` (wrong VOID class), `missingShellSiblingCount`, `skippedWrongClassCount`
- No double-counting: each branch increments exactly one of bounded/incomplete/invalidVoid
- **tunnelShellReport** extended with 6 new v4 metrics

### Expected Counts (beggars tomb)
- Up to 42 × 4 = 168 IfcRelSpaceBoundary (maximum ideal case)
- `boundedSpaceCount` = 42 (if all branches complete)

### Deployment
- Transform Lambda: zip uploaded to AWS (`builting-transform.zip`, 16MB)
- Generator Lambda: Docker build → ECR push (`builting-generate`) → Lambda update completed

---

## v5: Type-Based Color System + Descriptive Naming

### Generator (`lambda_function.py`)
- **TYPE_COLORS** dict: system-based colors (IfcFan→orange, DUCT→blue, WALL→gray, etc.)
- **SHELL_PIECE_COLORS** dict: LEFT_WALL/RIGHT_WALL/FLOOR/ROOF/VOID differentiation
- **Descriptive element naming**: shell piece labels, branch names, semantic type names — no more generic "WALL" or "SLAB" names
- **4-tier color precedence**: semanticType → shellPiece → css_type → material fallback
- **Proxy ObjectType enrichment**: IfcBuildingElementProxy gets semantic ObjectType

### Deployment
- Generator Lambda: Docker build → ECR push → Lambda update

---

## v6: Requirements-Closure Implementation (Phases 1-9 + A-H)

### Phase 1: Stabilization Guardrails (`builting-transform/index.mjs`)
- Added TUNNEL domain guard to `inferOpenings()` (was missing)
- Added TUNNEL domain guard to `checkEnvelopeFallback()` (was missing)
- Verified: `decomposeTunnelShell()`, `mergeWalls()`, `inferSlabs()` already had guards

### Phase 2: Generator Truthfulness (`lambda_function.py`)
- Style tier tracker: logs which color resolution tier was used per element type
- Name QA: counts generic vs descriptive names
- IFC class counts: logs all IFC entity types generated
- All logged to CloudWatch as `v6 Visual QA`, `v6 Name QA`, `v6 IFC classes`

### Phase 3: Tunnel Placement Correction (`builting-transform/index.mjs`)
- Cross-section clamping: projects equipment into void's local coordinate frame
- Clamps to inner dimensions with 0.25m margin
- Only EQUIPMENT in TUNNEL domain with matched void
- Preserves original position in `metadata.originalOrigin`
- `placementCorrectedCount` tracked in tunnelDecomposition metadata

### Phase 4: Building/Structure Hardening
- **Extract** (`builting-extract/index.mjs`): Dimension clamping (length 3-200m, width 3-200m, height 2.4-8m, wall thickness 0.1-1.0m, floors 1-50, storey height 2.4-8m)
- **Extract**: Automatic envelope fallback — when <4 walls or <2 slabs, rebuilds as 4 walls + floor + roof + door
- **Transform**: `validateBuildingStructure()` — checks exterior wall count, elements outside footprint, storey-z consistency
- **Generator**: Building completeness warning when walls <4 or slabs <2

### Phase 5: Quantity Sets (`lambda_function.py`)
- Wired `add_quantity_set()` for WALL (Qto_WallBaseQuantities), SLAB (Qto_SlabBaseQuantities), SPACE (Qto_SpaceBaseQuantities)
- Only when dimensions > 0 — additive only

### Phase 6: Validation + Regression
- **Transform**: CSS validation before S3 save — duplicate keys, NaN/Inf placement, invalid depth
- **Generator**: NaN coordinate check on first 20 placements (CRITICAL error)
- Validation results stored in CSS metadata and IFC validation report

### Phase 7: Source Contribution Report (`builting-extract/index.mjs`)
- Extended `buildTracingReport()` with: parsedFiles, geometryContributors, metadataContributors, ignoredFiles
- File-level attribution stored in DynamoDB via tracingReport

### Phase 8: Image/Blueprint Ingestion (`builting-extract/index.mjs`)
- Added image file support: PNG, JPG, JPEG, TIFF, TIF
- Scanned PDF detection: when pdf-parse returns <50 chars, falls back to Bedrock vision
- `extractFromImage()`: Bedrock Claude vision with structured extraction prompt
- `extractFromScannedPDF()`: Bedrock Claude document type for scanned PDFs
- Vision results tagged with `sourceRole: 'VISION'`, confidence 0.5
- Low-confidence vision results (<0.2) are dropped

### Phase 9: Restricted Safe Source Fusion (`builting-extract/index.mjs`)
- `extractDocumentFindings()`: Bedrock prompt to find fusible equipment in document text
- `attemptSafeSourceFusion()`: Creates non-structural elements from document findings
- Allowlist: PIPE, PUMP, TANK, HYDRANT, VALVE, SENSOR, CAMERA, CONTROL_PANEL, FIRE_SUPPRESSION, COMMUNICATIONS, SECURITY
- Safety rules: confidence ≥0.6, must anchor to existing space/segment, duplicate check, deterministic placement templates
- Wired into VentSim and DXF enrichment paths

### PHASE C: Engineer-Trust Evidence Trail
- Element-level evidence metadata on every CSS element: sourceFiles, basis, confidence, sourceType
- VentSim elements tagged with `VENTSIM_GEOMETRY` basis
- Building elements tagged with `LLM_EXTRACTION` basis
- `Pset_SourceProvenance` IFC property set on every element: Source, Confidence, EvidenceBasis, SourceFiles
- Comprehensive verification report generated and saved to S3: `reports/verification_report.json`
- Report includes: file contributions, source breakdown, element evidence mapping, validation results, source fusion log, scope boundary

### PHASE E: Building Visual Improvements (`lambda_function.py`)
- Added DOOR (wood brown), WINDOW (glass blue), COLUMN, PROXY colors to TYPE_COLORS
- Added infrastructure equipment colors: IfcFireSuppressionTerminal, IfcSensor, IfcActuator, etc.
- Glass transparency for WINDOW (0.4)
- Roof slab differentiation: darker color (0.40, 0.40, 0.45) for slabType=ROOF

### PHASE F: BIM Maturity — Revit Compatibility
- Revit compatibility assessment in verification report: GenericNames, ProxyRatio, SpatialHierarchy, QuantitySets, PropertySets, IFC4Schema
- Score reported as pass/total checks

### PHASE G: Regression Test Matrix
- Per-render test matrix in verification report
- Tunnel-specific: shell decomposition, equipment inside voids, blue ducts, orange fans
- Building-specific: exterior walls ≥4, floor+roof slabs ≥2, recognizable shape, openings
- Common: IFC valid, containment hierarchy, quantity sets, source provenance

### PHASE H: Honest Scope Boundary
- `scopeBoundary` section in verification report
- Lists: implemented features, partially implemented features, future work
- Transparent about MEP connectivity, curved tunnels, Revit round-trip as future work

### Zip Files Ready
- `builting-extract.zip` (1.7MB) — esbuild bundled
- `builting-transform.zip` (17KB) — single file
- Generator requires Docker build → ECR push

---

## Final Gap-Closure Phases (v6+ / 2026-03-13)

### Phase 1: Revit Compatibility Validation
- 12-check Revit compatibility validation in `validate_ifc()`:
  - SpatialHierarchy, RepresentationContext, NoUnsupportedEntities, AllPlacements, AllRepresentations
  - NoZeroExtrusions, ContainmentComplete, NamingQuality, UnitAssignment, CoordinateSanity
  - PreferredEntityRatio, GeometryBounds
- Scoring: pass/total checks, letter grade (A/B/C/D/F)
- REVIT_UNSUPPORTED and REVIT_PREFERRED entity sets for automatic checking
- Return value extended to 6-tuple including `revit_validation` dict

### Phase 2: Connected System Topology (MEP)
- IfcDistributionSystem creation for VENTILATION (ducts + fans) and PIPING systems
- IfcRelAssignsToGroup linking elements to their systems
- Port connectivity using VentSim entry_node/exit_node topology
- IfcDistributionPort creation (SOURCE/SINK) on duct segment endpoints
- IfcRelConnectsPortToElement and IfcRelConnectsPorts for adjacent segments sharing endpoint nodes

### Phase 3: Blueprint/Image Geometry Extraction Upgrade
- Two-step vision extraction: classify image type → use type-specific prompt
- VISION_CLASSIFY_PROMPT: detects FLOOR_PLAN, CROSS_SECTION, EQUIPMENT_LAYOUT, SITE_PLAN, ELEVATION, SPECIFICATION, PHOTO
- Type-specific VISION_PROMPTS with structured geometry outputs:
  - FLOOR_PLAN: walls, rooms, doors, windows, grid, scale detection
  - CROSS_SECTION: profile shape, dimensions, layers, equipment positions, zones
  - EQUIPMENT_LAYOUT: equipment with specs/dimensions, connections, system type
  - SITE_PLAN: building footprints with dimensions and orientation
  - ELEVATION: height, floors, windows/doors, roof type
- `visionToCSS()` function: confidence-gated conversion of vision results to CSS elements
  - Geometry only created when scale detected OR labeled dimensions present AND confidence ≥ 0.6
  - Below-threshold items stored as `visionFindings` metadata only
- Vision elements merged into CSS in all paths (VentSim, DXF, Bedrock extraction)
- `callBedrockVision()` shared helper for image and document vision calls

### Phase 4: Element-Level Evidence Mapping Upgrade
- Enhanced evidence tagging on all elements with detailed fields:
  - sourceExcerpt, pageNumber, paragraphIndex, sheetName, dxfLayer, dxfHandle
  - coordinateSource: DIRECT_3D (VentSim), DIRECT_2D (DXF), ESTIMATED (vision), LLM_GENERATED
  - sourceType: SIMULATION, CAD, IMAGE, TEXT
- Basis categories: VENTSIM_GEOMETRY, DXF_GEOMETRY, VISION_EXTRACTION, HEURISTIC_FALLBACK, LLM_EXTRACTION
- Pset_SourceProvenance enhanced with: SourceExcerpt, PageNumber, ParagraphIndex, SheetName, DxfLayer, DxfHandle, SourceType, CoordinateSource
- Evidence coverage metrics in verification report: evidencePct, excerptPct, coordinatePct

### Phase 5: Universal Building Robustness Expansion
- MEZZANINE section type: partial-height floors inside main building with slab + railing
- CANOPY section type: open-sided roof structure with 4 corner columns + roof slab
- Shared-wall detection: section edges aligned with main building skip duplicate wall generation
- L-shaped/U-shaped building support via main block + WING sections
- Updated Bedrock prompt with courtyard, mezzanine, canopy instructions
- COURTYARD_WALL section type in schema

### Phase 6: Viewer/Visualization Export
- Geometry statistics collection after IFC generation:
  - totalProducts, withRepresentation, extrusionCount, meshCount, brepCount
  - totalTriangles, totalVertices, simplificationRecommended flag
- Export format readiness detection: IFC4, glTF (via IfcConvert), OBJ
- Geometry stats included in verification report
- Updated scope boundary: glTF export readiness documented

### Phase 7: Full Verification Artifact (Engineer Audit)
- Report version upgraded to 2.0, type: ENGINEER_AUDIT_ARTIFACT
- Pipeline stages section: extract/transform/generate with version and metrics
- Quality assessment: letter grade (A/B/C/D), recommendations based on results
- Compliance checklist: IFC4_Schema, SpatialHierarchy, UniqueGUIDs, PropertySets, QuantitySets, ElementContainment, GeometryPresent, CoordinateSystem, MaterialAssignment
- Audit trail: input files, domain, pipeline version, output format/location
- Revit 12-check detailed validation results included
- Updated scope boundary with all new capabilities

### Phase 8: Final Safety Checks
- **Transform lambda**:
  - Element count limit: truncate at 5000 elements
  - Geometry bounds: detect elements beyond ±100km coordinates
  - Dimension limits: flag single dimensions > 10km
  - Overlap detection: same-type elements at identical positions (within 0.1m)
  - Model extent calculation with metadata: x/y/z extent, element count, duplicates, out-of-bounds
  - All results stored in css.metadata.safetyWarnings and css.metadata.modelExtent
- **Generator lambda**:
  - Pre-processing element count limit (5000 max)
  - Duplicate position detection with logging
  - Safety truncation before IFC generation

### Deployment (2026-03-13)
- `builting-extract` deployed (1.7MB zip)
- `builting-transform` deployed (18KB zip)
- `builting-generate` Docker image pushed to ECR and Lambda updated

---

## Final Engineering Hardening Pass (2026-03-13)

### B: Proxy Elimination
- **B1**: Source fusion assigns proper `semanticType` via `FUSION_SEMANTIC_MAP` (PIPE→IfcPipeSegment, PUMP→IfcPump, etc.) instead of hardcoded IfcBuildingElementProxy
- **B2**: Expanded `EQUIPMENT_SEMANTIC_MAP` from 8 to ~25 IFC classes; reordered `resolve_ifc_entity_type()` to check equipment semantic types FIRST (at confidence ≥0.4) before HYBRID confidence threshold
- **B3**: Vision-extracted elements now get proper `semanticType` (WALL→IfcWall, SPACE→IfcSpace, DOOR→IfcDoor, WINDOW→IfcWindow, equipment→VISION_EQUIP_MAP lookup)
- **B4**: Proxy tracking/reporting — `proxy_tracking` dict counts proxies and categorizes reasons (PROXY_ONLY mode, explicit PROXY type, low confidence, unmapped semantic, HYBRID threshold, unmapped CSS type); wired into validation report and CloudWatch logging
- **B5**: Tunnel segments now use proper IFC types instead of IfcBuildingElementProxy:
  - Main tunnel/portals/segments → `semanticType: 'IfcWall'`
  - Shafts → `semanticType: 'IfcColumn'`
  - Shaft collars → `semanticType: 'IfcPlate'`
  - `SEMANTIC_IFC_MAP['TUNNEL_SEGMENT']` changed from IfcBuildingElementProxy to IfcWall
  - Added `VALID_SEMANTIC_OVERRIDES` set in `resolve_ifc_entity_type()` to respect explicit semanticType for any element (IfcWall, IfcColumn, IfcPlate, etc.)

### C/F: Element Naming
- Improved fallback naming: semantic types get CamelCase spacing ("PipeSegment" → "Pipe Segment")
- Generic fallback uses `properties.usage` or `properties.segmentType` for context ("Equipment: Exhaust Fan — elem-42" instead of "EQUIPMENT — elem-42")

### G: BIM Maturity
- **G1**: Added quantity sets for DUCT (Qto_DuctSegmentBaseQuantities), PIPE (Qto_PipeSegmentBaseQuantities), COLUMN (Qto_ColumnBaseQuantities), DOOR (Qto_DoorBaseQuantities), WINDOW (Qto_WindowBaseQuantities) — previously only WALL/SLAB/SPACE had quantity sets
- **G2**: MESH method dispatch verified correct — IfcFaceBasedSurfaceModel creation working

### Deployment (2026-03-13)
- `builting-extract` deployed (1.6MB zip) with tunnel semanticType fixes
- `builting-generate` Docker image pushed to ECR and Lambda updated with proxy tracking, naming, quantity sets, and semantic type improvements

---

## Visual Accuracy + Semantic Cleanup Pass (2026-03-13)

### Phase 1: Visual Style System Repair
- **Root cause fix**: Added `IfcPresentationStyleAssignment` wrapper to styling chain — many IFC viewers (xeokit, Revit, BIMvision) require this intermediate entity to recognize styles
- Changed `ReflectanceMethod` from `FLAT` to `NOTDEFINED` for broader viewer compatibility
- Ensured `IfcColourRgb` values are explicit `float()` casts
- **Overhauled color palette** with high-contrast, visually distinct colors:
  - Structural: warm light gray walls, medium gray floors, dark gray roofs
  - MEP: strong blue ducts, vivid green pipes, yellow cable trays
  - Equipment: bright orange fans, teal pumps, red generators, purple compressors
  - Infrastructure: fire red suppression, lime green sensors, warm yellow lighting
  - Tunnel shell pieces: visually distinct wall/floor/roof/void colors
  - Added colors for all 25+ equipment semantic types

### Phase 2: Descriptive Naming
- Enhanced naming with type-prefixed element names (e.g. "Duct: Branch_1710" instead of "Branch_1710")
- Generic VentSim codes now include readable type context
- Semantic types get CamelCase spacing ("PipeSegment" → "Pipe Segment")
- Fallback names use properties.usage/segmentType/side for context
- Shell pieces show "Left Wall — Branch X (Name)" format

### Phase 3: Proxy Reduction
- Known structural/MEP types (WALL, SLAB, DUCT, PIPE, etc.) now ALWAYS promoted regardless of confidence
- TUNNEL_SEGMENT always maps to IfcWall
- HYBRID confidence threshold lowered from 0.7 to 0.5 for remaining types
- Only EQUIPMENT/PROXY without explicit semantic mapping can fall to proxy

### Phase 4: Tunnel Visual Improvements
- Shell piece colors clearly differentiated (walls gray, floor dark, roof darker, void translucent blue)
- Void transparency at 0.7 for see-through effect

### Phase 5: Building Visual Hardening
- Envelope structure verified (4 exterior walls, floor slab, roof per floor)
- Wall/slab/roof colors now visually distinct through palette update

### Phase 6: Visual QA Report
- Consolidated v7 QA summary in CloudWatch with style tier totals, generic name counts, proxy percentages
- Wired `styleReport`, `styleTierTotals`, `proxyTracking`, `genericNameCount` into verification report JSON

---

## Final Engineer Experience Pass (2026-03-13)

### Backend: Validation Data Pipeline
- Generator now outputs `validationSummary` (valid, errorCount, warningCount, proxyCount, proxyReasons, styleTierTotals, genericNameCount, totalElements, revitCompatScore)
- Store lambda saves `validationSummary` and computes `qualityScore` (weighted: 30% semantic coverage, 20% proxy reduction, 20% validation, 20% structure, 10% Revit compat)
- Router: new GET `/api/renders/{id}/report` endpoint fetches verification_report.json from S3
- API Gateway: added `/api/renders/{id}/report` resource with GET + OPTIONS methods

### Frontend: Details Panel Enhancements
- **Model Quality Score**: Circular progress ring showing 0-100 score with Excellent/Good/Needs Review labels
- **Validation Summary**: Checklist-style display (Geometry Valid, Spatial Hierarchy, Revit Compatibility %, Proxy Elements count/percentage, Errors, Warnings) with green/yellow/red color coding
- **Model Statistics**: IFC class counts as horizontal bar chart with colored dots, total element count, percentage bars
- **Source Contributions**: Renamed from "Generation Report", shows per-file role badges and element type breakdown
- **Download Report**: Button to download verification_report.json from S3
- All sections hide gracefully when data is unavailable

### Frontend: Renderbox Improvements
- Pipeline progress stages (Reading files → Extracting structure → Transforming geometry → Generating IFC → Running validation → Finalizing)
- Enhanced element pick chip: flex-column layout with readable type name, element name, and IFC class label
- Improved chip styling with blue accent border and larger max-width

### Deployment (2026-03-13)
- `builting-extract` deployed (1.6MB zip)
- `builting-generate` Docker image pushed to ECR (arm64)
- `builting-store` deployed with qualityScore computation
- `builting-router` deployed with /report endpoint
- API Gateway deployed with new /report resource
