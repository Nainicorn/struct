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

## Structural Realism Phase (v10 — 2026-03-13)

### Phase 1: Tunnel Shell Continuity (transform)
- `alignShellContinuity()`: cross-branch endpoint snapping, cross-section averaging within 15% tolerance
- Tags elements with `continuityGroupId` and `adjacentShellKeys`
- Non-destructive — preserves IfcElementAssembly, IfcSpace, branch identity

### Phase 2: Building Envelope Hardening (transform)
- `guaranteeBuildingEnvelope()`: generates fallback walls (N/S/E/W), floor slab, roof slab if missing
- All fallback elements marked `source: 'ENVELOPE_FALLBACK'`, `confidence: 0.4`, `isFallback: true`
- Domain guard: non-TUNNEL only

### Phase 3: Equipment Mounting (transform)
- `applyEquipmentMounting()`: deterministic wall/ceiling/floor mounting based on equipment type
- Origin guard: equipment at (0,0,0) relocated to first available space center
- Preserves `metadata.originalPlacement`

### Phase 4: Equipment Size Defaults (generator)
- `EQUIPMENT_SIZE_DEFAULTS` dict (20+ types): overrides 1x1x1 placeholder geometry
- Only fires when all three dimensions are exactly 1.0
- Preserves original in `metadata.originalGeometry`

### Phase 5: Curved Geometry First-Pass (transform)
- Removed circular tunnel skip — now approximates to rectangular inscribed
- Horseshoe shape support
- Tags with `geometryApproximation: 'CIRCULAR_TO_RECT'` / `'HORSESHOE_TO_RECT'`

### Phase 6: Source Data Improvements (extract)
- `MAX_TERTIARY` raised from 2KB to 10KB for VentSim data
- `fileContributions` map in `buildTracingReport()`: classifies each file as geometry/enrichment/unused

### Phase 7: Frontend Structural Notes (details panel)
- New "Structural Notes" section in details.hbs
- `_displayStructuralWarnings()` renders: envelope fallback, dimension clamps, shell continuity, equipment mounting, geometry approximations, safety warnings
- `structuralWarnings` stored in DynamoDB via store lambda

### Phase 8: Validation Regression Checks (generator)
- Origin cluster detection (>5% at 0,0,0 = ERROR)
- NaN/Inf placement check
- Semantic count validation (tunnel: walls+slabs+spaces, building: >=4 walls, >=2 slabs)
- Domain isolation (shellPiece only on TUNNEL, envelopeFallback only on non-TUNNEL)
- Proxy ratio check (>10% = WARNING)

### Phase 9: BIM Maturity — ObjectType Clarity (generator)
- Walls: `ObjectType = "Exterior Wall"` / `"Interior Wall"` based on isExternal
- Slabs: `ObjectType = "Roof Slab"` / `"Floor Slab"` based on slabType
- Equipment: human-readable names (IfcFan → "Ventilation Fan", IfcPump → "Pump", etc.)
- 20+ READABLE_TYPES mappings

### Phase 7C: Dimension Validation (transform)
- `clampAbsurdDimensions()`: universal clamping per element type (WALL, SLAB, SPACE, EQUIPMENT)
- Logs clamp count to `css.metadata.dimensionClamps`

### Deployment (v10 — 2026-03-13)
- `builting-extract` deployed (1.6MB esbuild bundle)
- `builting-transform` deployed (16MB zip)
- `builting-store` deployed with structuralWarnings field
- `builting-generate` Docker image pushed to ECR and Lambda updated

---

## 11. Wall Generation Regression Fix (v11 — 2026-03-13)

Full code audit identified 7 root causes of wall regression and implemented targeted fixes.

### Audit Findings
- Envelope fallback `avgConfidence < 0.4` included all elements — equipment at 0.3 dragged average below threshold, wiping rich models
- `mergeWalls()` used `geometry.direction` (Z-up extrusion) instead of wall horizontal direction
- `getWallLength()` returned `geometry.depth` (floor height) instead of profile span
- `getWallThickness()` returned `profile.width` (wall LENGTH for some walls) instead of min dimension
- Interior walls had no `refDirection` — all profiles defaulted to X-aligned regardless of actual direction
- `cleanBuildingWallAxes()` skipped all building walls because they lacked `placement.axis`
- Drift rejection weight (10x structural) too aggressive — 3 wall changes = rejection
- Guard ran before drift check — restored walls could be re-discarded
- Revit proxy ratio included transition helpers, inflating scores

### Fix 1B: Interior Wall refDirection (extract)
- Compute `refDirection` from `(dx/wallLength, dy/wallLength, 0)` when creating interior walls
- Guard against zero/near-zero wallLength before computing direction
- Walls now face their intended direction in the IFC viewer

### Fix 1C: Wall Geometry Helpers (transform)
- `getDir()`: prefers `refDirection` > `wallSide` property > `geometry.direction` fallback
- `getWallLength()`: returns `max(profile.width, profile.height)` — the longer profile dimension
- `setWallLength()`: updates the longer profile dimension (or width if ambiguous)
- `getWallThickness()`: returns `min(profile.width, profile.height)` — the narrower dimension
- Ambiguity guard: profiles with width/height ratio < 1.15 logged as ambiguous
- Module-level `ambiguousProfileCount` counter reset per invocation, stored in `css.metadata.ambiguousWallProfiles`

### Fix 1A: Domain-Aware Structural Confidence (extract)
- Replaced `avgConfidence` (all elements) with `structuralConfidence` (structural carriers only)
- Domain-aware carrier sets: ARCH (WALL, SLAB, COLUMN, BEAM, ROOF, STAIR, RAMP), TUNNEL (WALL, SLAB, TUNNEL_SEGMENT, COLUMN), INDUSTRIAL/CIVIL/STRUCTURAL variants
- Domain normalized to uppercase before lookup with ARCH fallback
- Equipment at 0.3 confidence no longer triggers false envelope fallback

### Fix 2A: cleanBuildingWallAxes Direction Inference (transform)
- Direction inference order: `refDirection` > `wallSide` property > horizontal `axis` (Z-up excluded)
- Endpoint movement cap on angular snap: if direction change would shift wall endpoint > 0.3m, snap is skipped
- Walls with `wallSide` (exterior) and `refDirection` (interior) now participate in axis cleanup

### Fix 3A: Safe Refinement (extract + frontend)
- Reordered: drift check runs FIRST on raw LLM output, guard runs SECOND as safety net
- Structural weight reduced from 10x to 5x (6 structural changes before rejection, was 3)
- `resolveRefinementTargets()` now returns `{ resolved, ambiguous }` with ambiguity tracking
- Ambiguous targets surfaced in `metadata.refinementReport.summary.unresolvedTargets` with `reason: 'AMBIGUOUS'`
- Frontend `_displayRefinement()` shows distinct warning for ambiguous matches vs unresolved targets

### Fix 4A: Revit Proxy Ratio (generate)
- Transition helper count excluded from proxy ratio calculation
- `canonical_proxy = IfcBuildingElementProxy count - transition_helper_count`
- Prevents false WARNING on Revit compatibility score

---

## 12. Revit-Quality IFC Output (v12 — 2026-03-13)

### Phase 1: Structural Realism
- **1A. Universal material layers**: Confidence-gated (>=0.6) IfcMaterialLayerSetUsage for all walls (AXIS2, thickness=min(w,h)) and slabs (AXIS3, thickness=depth). Skips placeholder 1×1×1 geometry. Thickness bounds: 0.01-2.0m.
- **1B. Material/style definition reuse**: Shared `_material_cache` by (name, thickness) → reused IfcMaterialLayerSet. Shared `_style_cache` by (color, transparency) → reused IfcPresentationStyleAssignment. New IfcStyledItem per solid, shared style chain. Caches cleared per generation run.
- **1C. Opening generation fix**: IfcOpeningElement now gets dedicated void geometry (rectangular extrusion matching wall thickness × opening width × opening height) instead of sharing door/window representation. Salvage-snapped openings marked with `evidence.basis = 'INFERRED_OPENING_SNAP'` and `isInferred: true`.
- **1D. Envelope regression safety**: Verified cleanBuildingWallAxes refDirection-first inference + 0.3m endpoint cap. Added `isApproximation: true` to all envelope fallback elements (walls, floor slab, roof slab).
- **1E. Approximation geometry marking**: New `Pset_ApproximationMetadata` (IsApproximation, ApproximationType) for transition helpers (TRANSITION_HELPER), envelope fallbacks (ENVELOPE_FALLBACK), inferred openings (INFERRED_OPENING), and shell approximations. Transition helpers in transform also marked with `isApproximation: true`.

### Phase 2: IFC Structural Completeness
- **2A. IfcRelDefinesByType**: Groups same-type elements (IfcWallType, IfcSlabType, IfcDuctSegmentType, etc.) by (entity_type, material, profile_key). Type name: "Wall:concrete 0.3x2.1" pattern. Created via IfcRelDefinesByType linking 2+ elements per group.
- **2B. Dual Axis+Body representation**: New `create_axis_representation()` helper generates Axis (Curve2D) centerline from start to end point. Walls/slabs/tunnel segments get dual representation (Axis + Body SweptSolid) like Revit reference. Added Axis (GRAPH_VIEW) and FootPrint (PLAN_VIEW) geometric subcontexts.

### Phase 3: Visual Polish
- **3A. Unified structural colors**: WALL/LEFT_WALL/RIGHT_WALL → concrete gray (0.753). SLAB/FLOOR/ROOF → slightly darker (0.65). COLUMN/BEAM → structural gray (0.72). MEP colors unchanged. VOID stays sky blue.
- **3B. Specular rendering**: All surfaces use Blinn reflectance with IfcSpecularExponent(64.0). Changed ReflectanceMethod from NOTDEFINED to BLINN.

### Phase 4: Geometry Quality
- **4A. Arbitrary profiles**: Junction transition helpers already use IfcArbitraryClosedProfileDef (chamfered octagonal profiles). All transition helpers now marked `isApproximation: true` in CSS properties.
- **4B. IfcFacetedBrep**: New `create_faceted_brep()` helper creates IfcClosedShell → IfcFacetedBrep for BREP geometry method. Restricted to transition/junction helper geometry only. Added BREP method handling in `create_element_geometry()` escalation chain.

---

## v12 — IFC Structural Realism (Revit-quality output) (2026-03-13)
1. Confidence-gated universal material layers for walls/slabs (IfcMaterialLayerSetUsage)
2. Material/style definition reuse — shared IfcMaterialLayerSet + IfcSurfaceStyle caches
3. Opening generation correctness — dedicated opening void geometry (not shared with door/window)
4. Approximation/helper geometry marking via Pset_ApproximationMetadata
5. IfcRelDefinesByType — type grouping for walls, slabs, ducts, etc.
6. Dual Axis+Body representations for walls/slabs (Axis Curve2D centerline)
7. Additional geometric subcontexts (Axis GRAPH_VIEW, FootPrint PLAN_VIEW)
8. Unified structural colors — concrete gray (0.753) for walls, slightly darker for slabs
9. Specular rendering — Blinn reflectance with SpecularExponent(64)
10. IfcFacetedBrep support for junction helper geometry (restricted scope)
11. Envelope fallback elements marked with isApproximation: true
12. Inferred/salvage-snapped openings marked with INFERRED_OPENING_SNAP evidence basis

---

## v13 — BIM Connectivity Sprint 1 (2026-03-13)

### Transform Lambda (builting-transform)
- **buildTopologyGraph(css)**: Domain-aware topology graph builder dispatching to:
  - `buildLinearTopology`: Tunnel/corridor topology from entry_node/exit_node on TUNNEL_SEGMENT elements. Builds nodes (TERMINAL/PATH_NODE/JUNCTION), runs (with shell piece references), junctions (with transition element links).
  - `buildArchitecturalTopology`: Building topology from wall endpoints with prioritized source order (explicit graph → host metadata → axis intersection → proximity fallback at 0.20m only as repair).
  - `buildHybridTopology`: Merges linear + architectural for mixed cases.
- **buildPathConnections(css)**: Creates PATH_CONNECTS relationships on elements:
  - Closed interface enum: ATSTART, ATEND, ATPATH, NOTDEFINED (validated, unknown rejected with warning)
  - Enriched schema: `{type, target, sourceInterface: {kind, node}, targetInterface: {kind, node}, role, metadata: {shellRole, sourceElementType, targetElementType}}`
  - Degree-2 nodes: connects matching shell roles (LEFT_WALL↔LEFT_WALL, etc.), skips VOID
  - Junction nodes: connects shell pieces to transition elements via ATPATH
  - Architectural junctions: direct T/L/cross connections without transition elements
  - Compatibility table: WALL↔WALL and SLAB↔SLAB only; proxy blocked in authoring_safe unless isProxyFallback
- **validateTopology(css)**: End-of-pipeline validation with hard pass/fail gates:
  - Structural run completeness (startNode/endNode required)
  - Degree-2 connectivity (PATH_CONNECTS required for matching shell roles)
  - Junction coverage (transition elements for linear, direct connections for architectural)
  - Opening host validation, merged-run preservation, proxy ratio checks
  - Profile-dependent gates: authoring_safe (95% connectivity, <5% proxy), coordination (80%), analysis (warnings only)
  - Writes `css.metadata.topologyValidation` with valid flag, errors, warnings, metrics
- **Pipeline insertion**: BuildTopologyGraph and BuildPathConnections after GenerateJunctionTransitions (Step 3E-2, 3E-3); ValidateTopology after safety checks (Step 10)
- **Export profile infrastructure**: `css.metadata.exportProfile` (authoring_safe/coordination/analysis) + `relationshipSchemaVersion: 2`

### Generate Lambda (builting-generate)
- **PATH_CONNECTS → IfcRelConnectsPathElements**: New relationship handler in the processing loop:
  - Resolves source/target IFC elements from ifc_by_key or ifc_elements_by_css_id
  - Validates elements are not IfcSpace or IfcOpeningElement
  - Maps interface kinds to IFC connection types (ATSTART/ATEND/ATPATH/NOTDEFINED)
  - Canonical dedup key: `sorted_keys|kinds|nodes|shellRole|role` — prevents duplicate A↔B relations while preserving distinct connections at different nodes
  - Backward compatible: old-style `{type, target}` relationships still work (NOTDEFINED connection types)

---

## v14 — Geometry Quality Strategy (Demo-Ready Visual Output) (2026-03-14)

### Context
BIM connectivity (v13) added semantic relationships but didn't fix visual geometry gaps — missing shell pieces, misaligned merges, insufficient junction extensions, and unclosed bends left the 3D model looking broken. This sprint implements a complete geometry quality strategy with measurable pass/fail gates for demo readiness.

### New Functions (Transform Lambda — builting-transform/index.mjs)

- **`auditShellCompleteness(css)`**: Inserted after `decomposeTunnelShell`. For each structural TUNNEL_SEGMENT, verifies LEFT_WALL, RIGHT_WALL, FLOOR, ROOF exist. Reconstructs missing pieces using parent dimensions + perpendicular offset (reuses decomposeTunnelShell offset/profile logic). Marks reconstructed pieces with `reconstructed: true`. Writes `css.metadata.shellCompleteness = { complete, missing, reconstructed }`.

- **`computeClosureTargets(css)`**: Computes per-role closure targets at each junction/bend node. For degree-2 bends: uses join plane (midpoint between shell piece endpoints, normal = perpendicular bisector of angle). For degree-3+: uses depth-weighted center or transition element boundary. Stores `css.closureTargets[node][shellRole] = { point, normal, source }` where source ∈ {JOIN_PLANE, TRANSITION_BOUNDARY, CENTER_FALLBACK}.

- **`auditGeometryGaps(css)`**: Post-fix gap measurement. Iterates adjacent same-role structural elements, measures endpoint gaps along shared axis. Classifies: CLEAN (<0.01m), MINOR_OVERLAP (0.01-0.10m overlap), VISIBLE_GAP (0.01-0.03m gap), SEVERE_GAP (>0.03m), EXCESSIVE_OVERLAP (>0.15m). Stores in `css.metadata.geometryGaps`.

- **`auditVisualGeometryQuality(css)`**: Final quality gate. Aggregates all gap/overlap/completeness metrics. Classifies as DEMO_READY / MARGINAL / FAIL. Thresholds: maxGap ≤0.03m, avgGap ≤0.01m, maxOverlap ≤0.15m, 0 missing shell roles, 0 unresolved junctions/bends.

### Revised Functions (Transform Lambda)

- **`mergeShellRuns`** — Fixed critical origin bug. Was: `first.placement.origin` + summed depths (shifted merged geometry). Now: computes true span from `first.origin - axis*firstDepth/2` to `last.origin + axis*lastDepth/2`, sets merged origin at midpoint. Added axis consistency validation (reject if >5° divergence between pieces). Preserves `mergedStartEndpoint` / `mergedEndEndpoint` in metadata.

- **`alignShellContinuity`** — Added endpoint snapping at degree-3+ junctions (previously only did dimension averaging). Uses closure targets to extend shell pieces to reach target point + 0.05m overlap margin. Caps extension at depth * 0.5 for sanity. Gap tolerance raised from 0.5m to 2.0m.

- **`extendShellAtJunctions`** — Replaced arbitrary `Math.min(0.5, depth * 0.1)` cap with target-based closure. Now computes actual gap to closure target: `EXTENSION = Math.min(gapToTarget + 0.05, depth * 0.5)`. Extension cap raised to 50% of original depth.

- **`generateJunctionTransitions`** — For degree-3+ junctions: weighted center computation (endpoint × depth / totalDepth instead of simple average). Plug depth = `Math.min(2 * maxGap + 0.3, 5.0)` (was `max(min(1.0, 0.15*maxDepth), min(2*maxGap, 3.0))`). For bends: depth = `Math.max(0.3, Math.min(gapDist * 1.3 + 0.2, 3.0))`.

### Overlap Control Policy
- Default visible overlap margin: 0.05m
- Max visible overlap beyond closure plane: 0.15m
- `extendShellAtJunctions` uses 0.05m overlap margin
- `alignShellContinuity` endpoint snap uses 0.05m overlap margin
- `generateJunctionTransitions` plugs overlap shells by up to 0.15m (hidden inside plug body)

### Pipeline Order (after v14)
1. DecomposeTunnelShell → 2. AuditShellCompleteness → 3. ComputeClosureTargets → 4. AlignShellContinuity → 5. ExtendShellAtJunctions → 6. MergeShellRuns → 7. GenerateJunctionTransitions → 8. AuditGeometryGaps → 9. AuditVisualGeometryQuality → 10. BuildTopologyGraph → 11. BuildPathConnections → 12. EquipmentMounting → ... → ValidateTopology

### Deployment (2026-03-14)
- `builting-transform` deployed to AWS (Lambda update successful)
- Generator Lambda: no changes needed (geometry fixes are entirely in transform)

---

## v2 Pipeline Refactor — Phase 0: Artifact Persistence (2026-03-14)

### Extract Debug Persistence
- Added `saveExtractDebug()` helper to `builting-extract`
- After each `saveCSSToS3()` call (3 code paths: VentSim, DXF, generic building), writes `pipeline/v{N}/extract_debug.json`
- Debug artifact contains: pipelineVersion, stage, generatedAt, durationMs, domain, elementCount, facilityName, sourceFiles, tracingReport, cssSnapshotKey
- Added `extractStartTime` timing at handler entry

### Transform Debug Persistence + Step Timing
- Wrapped all 25+ transform steps with `timedStep()` function that records `{ step, durationMs, elementsBefore, elementsAfter }`
- After saving `css_processed.json`, writes `pipeline/v{N}/transform_debug.json` with stepTimings array
- Also writes `pipeline/v{N}/issue_report.json` with validation results, CSS issues, safety warnings, repair count

### Store — Pipeline Metadata + Artifact Manifest
- Added `pipelineVersion: "1.0"` to DynamoDB update expression
- After DynamoDB update, writes `pipeline/v{N}/artifact_manifest.json` listing all artifacts, stages, and pipeline metadata
- Added S3 client import and `createHash` import for future checksum support
- Step Function updated to pass `bucket` to Store for S3 writes

### Step Function Update
- StoreIFC state now receives `bucket`, `validationSummary`, `sourceFusion`, `structuralWarnings` alongside existing fields

### Deployment
- `builting-extract`, `builting-transform`, `builting-store`, `builting-router` all deployed to AWS
- Step Function `builting-state-machine` updated with new definition

---

## Track B: Signed S3 IFC Download (2026-03-14)

### Backend (builting-router/renders.mjs)
- Replaced base64 download with S3 presigned URL (15-minute expiry)
- `getDownloadUrl()` now returns `{ downloadUrl, fileName, render }` instead of `{ fileData, fileName, render }`
- Uses `getSignedUrl()` (already imported) with `ResponseContentType` and `ResponseContentDisposition`

### Frontend (renderbox.js)
- Renamed `loadIFCFromBase64()` → `loadIFCFromUrl()` — fetches IFC via `fetch(url).arrayBuffer()`
- Updated 3 call sites: viewing render (line ~243), download button (line ~903), render completion (line ~966)
- Download handler now fetches from signed URL → blob → download link (no more base64 decode)

### S3 CORS
- `builting-ifc` bucket already had CORS configured for GET from `*` — no changes needed

### Deployment
- `builting-router` deployed to AWS with signed URL changes

## v2 Pipeline Refactor — Phase 1: Claims Dual-Write (2026-03-14)

### New files: `backend/lambda-functions/builting-extract/claims/`
- **claimsSchema.mjs** — Constants (`CLAIM_KINDS`, `TYPE_TO_KIND`, `CLAIM_STATUS`, `EXTRACTION_METHODS`, `COORDINATE_SOURCES`, `SOURCE_ROLES`), claim ID generation (`generateClaimId`, `resetClaimCounter`), evidence builder (`buildEvidence`), claim builder (`buildClaim`), envelope builder (`createClaimsEnvelope` with extraction report), helpers (`typeToKind`, `inferDiscipline`)
- **ventSimToClaims.mjs** — `ventSimCssToClaims(css, sourceFileName)`: converts VentSim CSS to claims post-hoc; preserves full element attributes for lossless reconstruction; returns `{ claims, domain, facilityMeta, parserArtifacts }`
- **dxfToClaims.mjs** — `dxfCssToClaims(css, sourceFileName)`: converts DXF CSS (storeys-based) to claims; maps storey elements with container refs; DXF handles/layers stored as evidence + aliases
- **buildingSpecToClaims.mjs** — `buildingSpecToClaims(css, sourceFiles)`: converts Bedrock-extracted building/tunnel CSS to claims; handles both BUILDING and TUNNEL domains; `detectSourceRole()` helper for file-based evidence
- **visionToClaims.mjs** — `visionToClaims(visionFiles)`: converts vision-extracted elements + findings to claims; low-confidence (0.30-0.40) with ESTIMATED coordinate source
- **claimsMerger.mjs** — `mergeClaims(primary, secondary)`: simple concatenation with subject_local_id dedup; secondary claims get `_secondary` suffix on collision
- **claimsToLegacyCss.mjs** — `claimsToLegacyCss(claimsDoc, parserArtifacts)`: routes by parserType (VENTSIM, DXF, BEDROCK_BUILDING, BEDROCK_TUNNEL, generic); DXF path reconstructs storeys from level_definition claims with element grouping by container

### Handler changes: `backend/lambda-functions/builting-extract/index.mjs`
- Added imports: `resetClaimCounter`, `createClaimsEnvelope`, `ventSimCssToClaims`, `dxfCssToClaims`, `buildingSpecToClaims`, `visionToClaims`, `mergeClaims`
- Added `saveClaimsToS3()` utility: saves `pipeline/v1/claims.json` to S3
- **VentSim exit** (~line 3775): `resetClaimCounter()` → `ventSimCssToClaims()` → `visionToClaims()` → `mergeClaims()` → `createClaimsEnvelope()` → `saveClaimsToS3()` — wrapped in try/catch (non-fatal)
- **DXF exit** (~line 3865): same pattern with `dxfCssToClaims()`
- **Bedrock exit** (~line 4398): same pattern with `buildingSpecToClaims()`
- All returns now include `claimsS3Key` (null if dual-write failed)

### Design decisions
- **Post-hoc claims**: existing parsers are unmodified — CSS output is converted to claims after the fact. Claims store complete element data in `attributes` for lossless reconstruction.
- **Non-fatal dual-write**: claims generation is wrapped in try/catch at every exit — pipeline continues on legacy CSS even if claims fail
- **Bundle size**: 5.7MB → 5.8MB (~100KB increase from 7 claims modules)

### Deployment
- `builting-extract` esbuild bundled and deployed to AWS (2026-03-14)

## v2 Pipeline Refactor — Phase 2: NormalizeClaims + ResolveClaims (2026-03-14)

### New Lambda: `builting-resolve` (Node.js 20, ARM64, 256MB, 30s timeout)

**5 source files, no npm dependencies — plain zip deployment (12KB):**

- **schemas.mjs** — Constants and mappings: `KIND_TO_OBSERVATION_TYPE`, `KIND_TO_CANDIDATE_CLASS`, `EXTRACTION_METHOD_PRIORITY`, `COORDINATE_SOURCE_PRIORITY`, `extractionMethodToClassSource()`, `buildCanonicalObservedEnvelope()`, `validateObservation()`, ID generators (`generateObservationId`, `generateCanonicalId`, `generateInstanceId`)
- **normalize.mjs** — `normalizeClaims(claimsDoc)`: unit conversion (ft/in/cm/mm → meters), coordinate convention normalization (RIGHT_HANDED_Z_UP), source role normalization to canonical set (NARRATIVE/SCHEDULE/SIMULATION/DRAWING/VISION) with alias mapping, claim shape validation (required fields, default fill), confidence clamping [0,1]. Preserves originals in `_original_units`, `_original_handedness`, `_original_labels`
- **resolve.mjs** — `resolveClaims(normalizedDoc)`: 3-signal claim grouping (subject_local_id match → alias overlap → spatial proximity), field conflict resolution (geometry by fieldConfidence + coordinate source priority, semantics by overall confidence + extraction method priority), observation building from resolved groups. Drops rejected claims and confidence < 0.2. Produces `resolutionReport` with claim groups, dropped claims, field resolutions, ambiguous groups
- **identity.mjs** — `assignIdentities(observations)`: Phase 2 assigns new canonical IDs (UUID-based) to all observations, builds `identity_map.json` with source handles (DXF handle, VentSim unique_no) and aliases. Designed for future prior-revision matching
- **index.mjs** — Handler: reads claims.json from S3, orchestrates normalize → resolve → identity pipeline, writes 4 artifacts in parallel via Promise.all, returns S3 keys + summary counts. No-op if `claimsS3Key` is null (legacy renders)

### Output artifacts (written to `pipeline/v1/`)
- `normalized_claims.json` — Same shape as claims.json with normalized values
- `canonical_observed.json` — v2.0 schema with observations (observation_id, canonical_id, instance_id, observation_type, candidate_class, geometry_evidence, semantic_evidence, context_evidence, provenance)
- `resolution_report.json` — Claim groups, dropped claims, field resolutions, identity assignments, summary
- `identity_map.json` — Canonical ID assignments with source handles, aliases, revision tracking

### Step Function changes
- Pipeline: Read → Extract → **Resolve** → Transform → Generate → Store
- `ExtractBuildingSpec.Next` changed from `CSSPipeline` to `ResolveClaims`
- New `ResolveClaims` state: reads `$.specResult.claimsS3Key`, writes to `$.resolveResult`
- Transform still reads `$.specResult.cssS3Key` — completely unaffected

### Deployment
- `builting-resolve` Lambda created on AWS (2026-03-14)
- Step Function `builting-state-machine` updated with ResolveClaims state (2026-03-14)

---

## Phase 3: Split Transform → builting-structure + builting-geometry (2026-03-14)

### Overview
Split the monolithic `builting-transform` Lambda (6,012 lines, 29 pipeline steps) into two focused Lambdas with v2 dual-write capability. The old `builting-transform` is kept deployed (unused) as a rollback safety net.

### New Lambda: builting-structure (StructureResolve)
- **Config**: Node.js 20, ARM64, 512MB, 120s timeout, builting-role
- **Pipeline**: ValidateCSS → RepairCSS → NormalizeGeometry → [TUNNEL] DecomposeTunnelShell → AuditShellCompleteness → ComputeClosureTargets → AlignShellContinuity → ExtendShellAtJunctions → MergeShellRuns → GenerateJunctionTransitions → ValidateTunnelGeometry → AuditGeometryGaps → AuditVisualGeometryQuality → BuildTopologyGraph → [BUILDING] MergeWalls → InferOpenings → CreateOpeningRelationships → ValidateOpeningPlacement → InferSlabs → GuaranteeBuildingEnvelope → CleanBuildingWallAxes → CheckEnvelopeFallback → ValidateBuildingStructure → ClampAbsurdDimensions
- **Input**: `{ cssS3Key (css_raw.json), userId, renderId, bucket }`
- **Output**: `{ cssS3Key (css_structure.json), inferredS3Key, elementCount, domain, validationResult }`
- **Dual-write**: `pipeline/v1/inferred.json` (v2 schema), `pipeline/v1/structure_inference_report.json`

#### Module structure:
- `shared.mjs` — Vector math, profile generators (duplicated with builting-geometry)
- `validation.mjs` — validateCSS, repairCSS, normalizeGeometry
- `tunnel-shell.mjs` — All tunnel shell decomposition functions (~2,947 lines)
- `building-envelope.mjs` — Wall merge, openings, slabs, envelope, dimension clamping (~1,448 lines)
- `topology-graph.mjs` — buildTopologyGraph + variants (~284 lines)
- `v2-adapter.mjs` — cssToInferred() dual-write converter
- `index.mjs` — Handler orchestrating the structure pipeline

### New Lambda: builting-geometry (GeometryBuild)
- **Config**: Node.js 20, ARM64, 256MB, 60s timeout, builting-role
- **Pipeline**: BuildPathConnections → ApplyEquipmentMounting → CSS Validation (duplicate keys, NaN, bounds) → Safety Checks (element count, coordinate bounds, overlap, extent) → ValidateTopology
- **Input**: `{ cssS3Key (css_structure.json), userId, renderId, bucket, validationResult }`
- **Output**: `{ cssS3Key (css_processed.json) }` — backward compatible for Generate
- **Dual-write**: `pipeline/v1/resolved.json` (v2 schema), `pipeline/v1/geometry_build_report.json`, `pipeline/v1/transform_debug.json`, `pipeline/v1/issue_report.json`

#### Module structure:
- `shared.mjs` — Vector math, profile generators (duplicated with builting-structure)
- `path-connections.mjs` — buildPathConnections, inferRunEnd (~247 lines)
- `equipment.mjs` — applyEquipmentMounting (~156 lines)
- `safety.mjs` — validateCSSElements, runSafetyChecks (~115 lines)
- `topology-validate.mjs` — validateTopology (~218 lines)
- `v2-adapter.mjs` — cssToResolved() dual-write converter
- `index.mjs` — Handler orchestrating the geometry pipeline

### Step Function changes
- Pipeline: Read → Extract → Resolve → **StructureResolve** → **GeometryBuild** → Generate → Store
- `ResolveClaims.Next` changed from `CSSPipeline` to `StructureResolve`
- New `StructureResolve` state: reads `$.specResult.cssS3Key`, writes to `$.structureResult`
- New `GeometryBuild` state: reads `$.structureResult.cssS3Key`, writes to `$.pipelineResult`
- GenerateIFC still reads `$.pipelineResult.cssS3Key` — unchanged
- Old `CSSPipeline` state removed (builting-transform Lambda kept deployed for rollback)

### New S3 artifacts
- `css/css_structure.json` — Intermediate CSS between StructureResolve and GeometryBuild
- `pipeline/v1/inferred.json` — v2 inferred schema dual-write
- `pipeline/v1/resolved.json` — v2 resolved schema dual-write
- `pipeline/v1/structure_inference_report.json` — Structure stage timing + metrics
- `pipeline/v1/geometry_build_report.json` — Geometry stage timing + metrics

### Deployment
- `builting-structure` Lambda created on AWS (2026-03-14)
- `builting-geometry` Lambda created on AWS (2026-03-14)
- CloudWatch log groups created: `/aws/lambda/builting-structure`, `/aws/lambda/builting-geometry`
- Step Function `builting-state-machine` updated with StructureResolve + GeometryBuild states (2026-03-14)

---

## Phase 4: Legacy Adapter Boundary (`resolvedToLegacyCss`) — deployed 2026-03-15

### What changed
- `resolved.json` is now the **canonical output** of the Geometry Lambda
- `css_processed.json` is **derived from resolved.json** via `resolvedToLegacyCss()`, not written directly from CSS
- This proves the v2 resolved schema is lossless for Generate's needs

### `cssToResolved` fixes (builting-geometry/v2-adapter.mjs)
- Added `source`, `sourceFile`, `evidence` to resolved element schema (previously dropped)
- Added `geometry.method` (original CSS method string, alongside `intent`)
- Added `geometry.direction` (extrusion direction vector)
- Added `geometry.vertices` and `geometry.faces` (actual mesh data, not just `meshRef`)
- Added `geometry.method` BREP intent mapping
- Preserved CSS metadata fields needed for round-trip: `outputMode`, `placementZIsAbsolute`, `sourceFusion`, `interiorSuppression`, `tunnelDecomposition`, `repairLog`, `cssValidationIssues`, `cssValidationDetails`, `ambiguousWallProfiles`

### `resolvedToLegacyCss` (new function in builting-geometry/v2-adapter.mjs)
- Reverse adapter: resolved.json → CSS v1.0 format for Generate consumption
- `element_key` → CSS `id` (preserves original legacy id, not canonical_id)
- `geometry.method` precedence: prefer preserved `method` field, fallback `intent` → uppercase
- `evidence` → nested back under `metadata.evidence` on each element
- Reconstructs `cssVersion: '1.0'`, `levelsOrSegments`, `facility`, `topology`, full `metadata`
- Adds `adapterSource: 'resolvedToLegacyCss'` and `resolvedSchemaVersion` to metadata

### Geometry Lambda pipeline flow change (builting-geometry/index.mjs)
- Old: CSS → css_processed.json (direct) + resolved.json (dual-write)
- New: CSS → resolved.json (canonical) → css_processed.json (via resolvedToLegacyCss)
- Added round-trip fidelity check: compares critical fields (id, type, confidence, geometry.method, geometry.depth, placement.origin, container) between original CSS and adapter output, logs mismatches

### `cssToInferred` fixes (builting-structure/v2-adapter.mjs)
- Added `element_key`, `name`, `source`, `sourceFile`, `evidence`, `material` to inferred schema
- Added `geometry.method`, `geometry.direction`, `geometry.vertices`, `geometry.faces` to geometryHypothesis
- Added BREP intent mapping

### Deployment
- `builting-geometry` Lambda updated (2026-03-15)
- `builting-structure` Lambda updated (2026-03-15)

---

## Phase 5: ValidateModel (builting-validate) — deployed 2026-03-15

### New Lambda: builting-validate (Node.js 20, arm64, 256MB, 60s)
- Pure read + assess + report validation stage between GeometryBuild and GenerateIFC
- Non-blocking: pipeline continues regardless of validation outcome
- Reads resolved.json, produces validation_report.json with per-element issue objects

### Validation Modules
- **config.mjs**: Central config with all tolerances, mapping tables, domain minimums, gate definitions, severity defaults, type-dependent unresolved container severity, cross-domain suspicious combos, blocks-export checks
- **semantic.mjs**: Confidence distribution, proxy ratio, type↔semanticType alignment via allowed mapping table, generic name detection, cross-domain entity detection (config-driven), unresolved semantic class warnings
- **geometric.mjs**: Local frame sanity (axis, refDirection, collinearity), NaN/Inf/bounds checks, profile/depth validity, mesh sanity (missing vertices/faces, face index bounds, degenerate faces, bbox), suspicious coincident placement (not raw duplicates — checks for host/containment relationships), model extent computation
- **topological.mjs**: Container convention validation (null+flag=severity-by-type, null+no-flag=error, invalid-ref=error), relationship integrity (dangling targets, self-refs, contradictory HOSTED_BY+VOIDS), opening host validation (orphaned openings, invalid host types), PATH_CONNECTS coverage for degree-2 nodes, equipment hosting
- **structural.mjs**: A. Minimum viability (domain minimums, container presence, shell pieces) + B. Coherence (shell naming consistency, orphaned opening proximity, disconnected envelope, merged run topology, proxy fallback flags)
- **readiness.mjs**: 10 gates (hard/soft), readiness score (0–100) blending ratios + issue severity penalties, exportReadiness (hard gates), authoringSuitability (FULL_AUTHORING/COORDINATION_ONLY/VIEWER_ONLY/NOT_RECOMMENDED), generationModeRecommendation (FULL_SEMANTIC/HYBRID/PROXY_ONLY), actionable recommendations array

### Issue Object Format
```json
{
  "issue_id": "geom-0012",
  "category": "semantic|geometric|topological|structural",
  "severity": "error|warning|info",
  "impact": "viewer|generator|authoring|topology|semantic",
  "check": "invalid_depth",
  "element_ids": ["canon-abc123"],
  "message": "Extrusion depth must be > 0, got 0",
  "auto_repaired": false,
  "blocks_export": false
}
```

### 10 Readiness Gates
- Hard: noNaNCoordinates, noInvalidPlacements, noDanglingRelationships, noInvalidProfiles, noInvalidExtrusionDepths, domainMinimumsMet, extentWithinSafePrecision, meshGeometrySane
- Soft: noUnresolvedContainers, noBrokenOpeningHosts

### Pipeline Integration
- Step Function updated: GeometryBuild → ValidateModel → GenerateIFC
- GeometryBuild now returns resolvedS3Key alongside cssS3Key
- StoreIFC persists 8 validation fields to DynamoDB: readinessScore, exportReadiness, authoringSuitability, criticalIssueCount, validationWarningCount, validationProxyRatio, validationReportS3Key, generationModeRecommendation
- Compact summary returned to Step Function; full report in S3

### Deployment
- `builting-validate` Lambda created (2026-03-15)
- `builting-geometry` Lambda updated — returns resolvedS3Key (2026-03-15)
- `builting-store` Lambda updated — persists validation fields (2026-03-15)
- `builting-state-machine` Step Function updated — ValidateModel state added (2026-03-15)

---

## Phase 6: Refinement Scope Metadata (deployed 2026-03-15)

### Artifact Versioning
- All pipeline stages now use dynamic `render_revision` instead of hardcoded `revision = 1`
- `renderRevision` passed through Step Function from `$.metadata.render.render_revision` to all stages
- Refinement artifacts saved under `pipeline/v{revision}/` — prior versions preserved
- `builting-read` ensures `render_revision` defaults to `1` for first renders (Step Function JsonPath safety)

### Refinement Report Artifact
- Dedicated `refinement_report.json` saved to `pipeline/v{revision}/` in S3
- Includes: refinementType, scopeConfidence, scopeConfidenceBreakdown, refinementLineage, changedCanonicalIds, addedCanonicalIds, removedCanonicalIds, affectedScope, pipelineDurationMs
- `refinementReportS3Key` persisted to DynamoDB via Store

### Refinement Type Classification
- Heuristic classification from refinement text + affected target types
- Values: STRUCTURAL_CHANGE, EQUIPMENT_CHANGE, OPENING_CHANGE, PARAMETER_CHANGE, CLASSIFICATION_CHANGE, MIXED

### Scope Confidence (deterministic formula)
- `scopeConfidence = 50% targetResolutionConfidence + 30% driftCompliance + 20% elementMatchStability`
- targetResolutionConfidence: proportion of declared targets successfully resolved
- driftCompliance: proportion of out-of-scope elements unchanged
- elementMatchStability: proportion of prior canonical IDs preserved
- Clamped to 0-100

### LLM_REFINEMENT Extraction Method
- `buildingSpecToClaims()` accepts `options.isRefinement` parameter
- Claims generated during refinement now use `EXTRACTION_METHODS.LLM_REFINEMENT` instead of `LLM_EXTRACTION`

### Readiness Delta
- ValidateModel accepts `previousValidationReportS3Key` from DynamoDB (prior render's validation report)
- When `renderRevision > 1` and prior report exists, computes `readinessDelta`:
  - previousScore, currentScore, delta, previousIssueCount, currentIssueCount, issueDelta
  - previousAuthoringSuitability, currentAuthoringSuitability, improved (boolean)
- Delta persisted to DynamoDB via Store; gracefully skipped if prior report missing

### Artifact Manifest v2
- Updated stageOrder: `['read', 'extract', 'resolve', 'structure', 'geometry', 'validate', 'generate', 'store']`
- Dynamic artifact list includes all v2 pipeline artifacts (claims, normalized_claims, canonical_observed, resolution_report, identity_map, inferred, resolved, validation_report, refinement_report)
- `priorRevisionArtifactManifestS3Key` links to previous revision manifest when `revision > 1`
- `refinementLineage` tracks revision chain
- `featureFlags.PIPELINE_V2 = true`, `generatorCompatibilityMode = 'v2_css'`

### Frontend Display
- Readiness delta: `"Readiness: 72 → 85 (+13)"` with green/red/neutral coloring
- Authoring suitability transition: `"Authoring: VIEWER_ONLY → COORDINATION_ONLY"`
- Scope confidence: progress bar with color bands (green ≥70, yellow 40-69, red <40) and numeric label
- Refinement type display (when not MIXED)

### Deployment
- `builting-read` Lambda updated — render_revision defaults (2026-03-15)
- `builting-extract` Lambda updated — refinement report artifact, LLM_REFINEMENT, scope confidence (2026-03-15)
- `builting-resolve` Lambda updated — dynamic revision (2026-03-15)
- `builting-structure` Lambda updated — dynamic revision (2026-03-15)
- `builting-geometry` Lambda updated — dynamic revision (2026-03-15)
- `builting-validate` Lambda updated — readiness delta computation (2026-03-15)
- `builting-store` Lambda updated — new fields, v2 manifest (2026-03-15)
- `builting-state-machine` Step Function updated — renderRevision, previousValidationReportS3Key, refinementReportS3Key, readinessDelta parameters (2026-03-15)

---

## Phase 7: ECS/Fargate Migration Design (2026-03-15)

### Design document only — no infrastructure or code changes

Created architecture design document at `backend/architecture/ecs-fargate-migration.md` covering:

- **Migration candidates:** `builting-generate` identified as primary candidate (already containerized in ECR, heaviest workload, most likely to hit Lambda 15-min timeout and 10 GB memory limits). `builting-extract` as secondary candidate (keep on Lambda, evaluate later). All other Lambdas remain on Lambda.
- **Hybrid architecture:** Step Functions remains the orchestrator. Only Generate moves to Fargate; 7 lightweight stages stay on Lambda. Workflow definition and artifact flow unchanged.
- **ECS/Fargate architecture:** Fargate launch type, ARM64, single cluster `builting-cluster`, VPC with private subnets, VPC endpoints for S3/ECR/CloudWatch. Initial task sizing: 2 vCPU, 8–16 GB memory.
- **Step Functions integration:** `ecs:runTask.sync` pattern replacing Lambda invocation. S3-based I/O (matching existing pipeline pattern). New `builting-read-output` Lambda bridges ECS output to Step Functions.
- **IAM & networking:** Per-function least-privilege roles (`builting-ecs-execution-role`, `builting-generate-task-role`). Private subnets, VPC endpoints, no public IP.
- **Cost analysis:** Fargate ~2× per-render cost vs Lambda + $21.60/mo endpoint fixed costs. Fargate is a capability unlock (no timeout/memory limits), not a cost optimization.
- **Migration strategy:** 4 sub-phases (infrastructure setup → container adaptation → Step Functions cutover → observation). Rollback = single state machine definition revert.
- **Monitoring:** CloudWatch Logs, Container Insights, custom metrics, ECS task exit codes/duration, alarms for failure rate and resource utilization.

---

## Phase 8: IFC Geometry Fidelity & Interoperability (2026-03-15)

### Sub-phase 8a.1: Curved Geometry Support — Swept Disk + Hollow Profiles

- **`IfcSweptDiskSolid` support:** Added `create_swept_disk_solid()` in `lambda_function.py` — circular cross-section swept along polyline directrix path. Used for DUCT and PIPE elements with circular profiles. Falls back to extrusion if pathPoints missing or sweep creation fails.
- **`IfcCircleHollowProfileDef` support:** Extended `create_profile()` to detect `wallThickness` on CIRCLE profiles and create hollow circular profiles instead of solid ones.
- **SWEEP method branch:** Updated `create_element_geometry()` with `method == 'SWEEP'` handling — synthesizes straight path from origin+direction if pathPoints absent, tracks `sweep_to_extrusion` fallback.
- **Upstream SWEEP annotation:** Added `annotateSweepGeometry()` step in `builting-geometry/index.mjs` — automatically annotates DUCT/PIPE elements with circular profiles to use SWEEP method, constructs pathPoints from placement origin + direction * depth.
- **Polygon resolution upgrade:** Increased arc segment counts in `tunnel-shell.mjs` — `ARC_SEGMENTS` 12→24, `generateCirclePoints` 16→32, `generateHorseshoePoints` 12→24 for higher fidelity polygon approximations.
- **Export method tracking:** Added `sweptDiskCount`, `revolvedCount`, `curveRequestedButFellBackCount` to geom_stats in the generator.

### Sub-phase 8b: Reduce Proxy Geometry

- **Expanded `SEMANTIC_IFC_MAP`:** Added 7 new structural types — RAILING→IfcRailing, STAIR→IfcStair, RAMP→IfcRamp, ROOF→IfcRoof, CURTAIN_WALL→IfcCurtainWall, COVERING→IfcCovering, FOOTING→IfcFooting.
- **Expanded `EQUIPMENT_SEMANTIC_MAP`:** Added 8 new equipment types — IfcHeatExchanger, IfcAirTerminal, IfcFlowMeter, IfcFilter, IfcDamper, IfcCoil, IfcCoolingTower→IfcUnitaryEquipment, IfcConveyor→IfcTransportElement.
- **Type-specific proxy promotion rules:**
  - STAIR, RAMP, ROOF, FOOTING added to `ALWAYS_PROMOTE` (promoted regardless of confidence)
  - RAILING, CURTAIN_WALL, COVERING promoted at confidence >= 0.4
  - General HYBRID threshold lowered from 0.5 to 0.4 (conservative step)
- **Common property sets:** Added Pset_DoorCommon, Pset_WindowCommon, Pset_ColumnCommon, Pset_BeamCommon. Enhanced existing Pset_WallCommon and Pset_SlabCommon with `Reference` field. All property sets only attached when CSS element has the corresponding data.
- **Validation sync:** Updated `ALLOWED_SEMANTIC_TYPES` in `builting-validate/config.mjs` with all new types (RAILING, STAIR, RAMP, ROOF, CURTAIN_WALL, COVERING, FOOTING, PIPE).

### Sub-phase 8c: Validation & Metrics Update

- **Curved geometry validation:** Added SWEEP validation (pathPoints >= 2, radius > 0), REVOLUTION validation (angle 0-360, valid axis, valid profile) in `geometric.mjs`.
- **Curve approximation detection:** Detects ARBITRARY polygon profiles with curved intent (circular/horseshoe shape annotations) and flags as `curve_approximated_as_polygon` (info severity).
- **Geometry fidelity metrics:** Added `geometryFidelity` object to validation summary — `nativeCurveRatio`, `polygonApproxRatio`, `sweepCount`, `revolutionCount`, `curveApproxCount`.
- **Check severities:** Added 7 new check entries in `config.mjs` — `curve_approximated_as_polygon` (info), `sweep_missing_path`, `sweep_invalid_radius`, `revolution_missing_axis`, `revolution_invalid_angle`, `revolution_missing_profile` (all error). Added sweep/revolution checks to `BLOCKS_EXPORT_CHECKS`.
- **Fidelity passthrough:** `geometryFidelity` passed through `builting-validate/index.mjs` return, persisted in `builting-store/index.mjs` DynamoDB update, and routed through Step Function via `$.validationResult.geometryFidelity`.

### Sub-phase 8d: Interoperability Test Suite

- **`test_revit_interop.py`:** Automated IFC validation with 10 checks across 3 categories:
  - Schema/structure: no IfcWallStandardCase, walls have PredefinedType, storeys exist with valid elevations, spatial containment
  - Geometry: IfcSweptDiskSolid presence for MEP, no NaN/Inf coordinates, direction vectors unit-length
  - Revit compatibility: material layers on walls/slabs, property set coverage, category distribution
  - Manual Revit import checklist documented as docstring
  - Produces `revit_interop_report.json`
- **`test_regression_ifc.py`:** Structural fingerprint comparison against golden baselines:
  - Extracts sorted list of (entity_type, name, storey_name) from generated IFC
  - Compares against saved baselines, reports additions/removals/type changes
  - `--update-baselines` flag for intentional changes
  - Baselines directory at `builting-generate/baselines/`

### Deployments (2026-03-15)
- `builting-structure` Lambda updated — polygon resolution upgrade, ARC_SEGMENTS 24
- `builting-geometry` Lambda updated — SWEEP annotation step, higher circle/horseshoe resolution
- `builting-validate` Lambda updated — curved geometry checks, fidelity metrics, expanded ALLOWED_SEMANTIC_TYPES
- `builting-generate` container rebuilt — IfcSweptDiskSolid, IfcCircleHollowProfileDef, expanded semantic maps, property sets, proxy threshold, geom_stats
- `builting-store` Lambda updated — geometryFidelity persistence
- `builting-state-machine` Step Function updated — geometryFidelity passthrough

---

## 11. Phase 9 — Advanced Drawing & Blueprint Extraction (2026-03-15)

### Sub-Phase 9a: Enhanced Prompts + Title Block + Page Roles
- **Title block extraction**: New `TITLE_BLOCK_PROMPT` + `extractTitleBlock()` — extracts projectName, drawingNumber, sheetNumber, revision, date, scale, author, firm with per-field confidence. Runs as Pass 0 before image classification.
- **Page role classification**: `classifySheetRole()` maps image types to sheet roles (FLOOR_PLAN, ELEVATION, SECTION, SCHEDULE, etc.). `isGeometryDrawingRole()` gates geometry extraction — non-drawing pages skipped for geometry but text preserved.
- **Enhanced FLOOR_PLAN prompt**: Requests wall start/end coordinates (x, y), room positions, door/window offset_m along host wall, grid line positions. `hasCoordinates`/`hasPosition` flags enforce honest reporting. Includes `dimensionAnnotations` for scale cross-checking.
- **Enhanced ELEVATION prompt**: Requests per-floor elevation values, `floors[]` with elevation_m/height_m, window/door xOffset_m, `levelLabels`, `roofElevation_m`.
- **Evidence metadata fields**: Added to `claimsSchema.mjs` — `ASSEMBLED_2D` coordinate source, `COORDINATE_DERIVATION` enum, `SHEET_ROLES` enum. `buildEvidence()` extended with `sheetRole`, `coordinateDerivation`, `scaleConfidence`, `drawingMetadata`.
- **Title block → render metadata**: Best title block projectName used as `ai_generated_title`. Drawing number/revision/firm appended to description.
- Image size limit increased from 5MB to 20MB (Bedrock maximum).

### Sub-Phase 9b: Spatial Layout Assembly (Heuristic Reconstruction)
- **`assembleFloorPlanLayout()`**: Assembles floor plan elements into coordinate-bearing layout with strict priority: (1) direct coordinates from prompt → `DIRECT_2D`, (2) heuristic placement from side + overall dimensions → `ASSEMBLED_2D`, (3) fallback to origin → `ESTIMATED`. Includes room packing (left-to-right, bottom-to-top within envelope) and door/window offset along host walls.
- **Helper functions**: `placeWallBySide()`, `resolveHostWall()`, `computeOffsetAlongWall()`, `wallMidpoint()` — coordinate geometry utilities for wall placement and opening positioning.
- **`assembleElevationLayout()`**: Assembles vertical layout from elevation data — floor elevations, window z-placement at floor elevation + sill height, door placement at ground level.
- **`correlateDrawings()`**: Cross-drawing correlation between floor plans and elevations. Requires at least 2 strong matching signals (same project name, same drawing number series, consistent dimensions, shared level labels). Conservative by default — no forced merges.
- **`visionToCSS()` updated**: FLOOR_PLAN path now calls `assembleFloorPlanLayout()` for coordinate-bearing elements. ELEVATION path calls `assembleElevationLayout()`. Assembly stats stored as INFORMATIONAL finding. `coordinateDerivation` stored in element metadata.
- **`visionToClaims.mjs` updated**: Per-element coordinate source derived from `coordinateDerivation` metadata. `DIRECT_2D` → placement confidence 0.55, `ASSEMBLED_2D` → 0.45, `ESTIMATED` → 0.30. Evidence includes sheetRole, coordinateDerivation, scaleConfidence, drawingMetadata.
- **Cross-drawing correlation wired**: Elevation floor heights applied to matching level definitions in CSS when floor plan ↔ elevation correlation succeeds.

### Sub-Phase 9c: Multi-Page PDF Vision + Scale Calibration
- **`extractFromMultiPagePDF()`**: Processes up to 5 pages individually with page role classification, title block extraction (first found only), type-specific geometry extraction. Page prioritization: FLOOR_PLAN/ELEVATION first, skip SCHEDULE/TITLE_SHEET/UNKNOWN for geometry. Early stop on 2 consecutive low-confidence pages. Total budget: 120s.
- **`callBedrockVisionWithTimeout()`**: Per-call 30s timeout wrapper using `Promise.race()`.
- **Main handler updated**: Scanned PDF detection now checks page count via pdf-parse. Multi-page PDFs (pageCount > 1) route to `extractFromMultiPagePDF()`. Each geometry page produces a separate visionCSS with page number in evidence. Falls back to single-page path for 1-page PDFs.
- **`calibrateScale()`**: Parses scale ratios from title block and dimension annotations. Title block scale provides initial prior. Dimension annotations boost confidence only when ≥2 confident + consistent measurements. `parseScaleRatio()` handles "1:100", "1/50", "1 to 200" formats.
- Scale calibration wired into both `extractFromImage()` and `extractFromScannedPDF()`.

### Sub-Phase 9d: Vision-to-BuildingSpec Bridge + Confidence Tuning
- **`canBridgeToBuildingSpec()`**: Qualification check — only FLOOR_PLAN with overallDimensions and at least 1 wall/room at confidence ≥ 0.4.
- **`visionToBuildingSpec()`**: Converts assembled vision floor plan into `buildingSpec` schema (compatible with `buildingSpecToCSS()`). Maps rooms, doors, windows to spec format. Detects average wall thickness from extracted walls. Scoped to simple orthogonal buildings.
- **Drawing-primary handler routing**: When primary input is drawing(s) with no substantial text/VentSim/DXF, qualifies via `canBridgeToBuildingSpec()`, routes through `visionToBuildingSpec()` → `buildingSpecToCSS()` for proven coordinate placement. Falls back to standard Bedrock extraction if not qualified. Route logged as `VISION_BRIDGE` in CSS metadata.
- **Component-based confidence model**: In `visionToClaims.mjs`, per-element confidence derived from three independent components: document confidence (title block quality — does NOT inflate geometry), geometry confidence (scale + dimension annotations + wall endpoints), placement confidence (coordinate derivation method). Final element confidence = geometry×0.5 + placement×0.3 + document×0.2.
- **`resolveWallSide()`**: Maps hostWall references to compass sides for buildingSpec openings.

### Files Modified
- `backend/lambda-functions/builting-extract/index.mjs` — All 4 sub-phases: prompts, assembly functions, multi-page PDF, bridge routing
- `backend/lambda-functions/builting-extract/claims/claimsSchema.mjs` — ASSEMBLED_2D, COORDINATE_DERIVATION, SHEET_ROLES, extended buildEvidence()
- `backend/lambda-functions/builting-extract/claims/visionToClaims.mjs` — Per-element coordinate source, component-based confidence, drawing metadata evidence

### Deployments (2026-03-15)
- `builting-extract` Lambda updated 4× (once per sub-phase) — esbuild bundle 5.8MB, no new npm dependencies

---

## Phase 11 — Additional Visualization Export Formats (2026-03-15)

Adds glTF (.glb) and OBJ (.obj) export alongside the primary IFC4 output, enabling lightweight 3D visualization in web engines (three.js, Babylon.js), game engines (Unreal Engine 5, Unity), and universal 3D tools (Blender, Maya, 3ds Max).

### Architecture
- **Eager conversion** inside `builting-generate` Lambda after IFC creation, using `trimesh` + `ifcopenshell.geom` with `USE_WORLD_COORDS=True` to preserve correct spatial placement
- **Non-blocking**: entire conversion wrapped in try/except with 30-second time budget; failures log warnings but never block IFC generation
- **Guard rails**: conversion skipped when `simplificationRecommended=True` (>50k triangles or >500 products)

### Backend Changes
- **builting-generate** (lambda_function.py): Added `_convert_ifc_to_exports()` and `_resolve_export_color()` functions. Iterates IfcProduct geometry, builds trimesh.Scene with type-aware colors (same precedence as IFC: semanticType → css_type → material), exports to `/tmp/model.glb` and `/tmp/model.obj`, uploads to `builting-ifc/{userId}/{renderId}/`. Returns `exportFormats` and `exportFiles` in handler response.
- **requirements.txt**: Added `trimesh` and `numpy`
- **builting-store** (index.mjs): Persists `exportFormats` and `exportFiles` to DynamoDB `builting-renders` table. Adds export artifacts to `artifact_manifest.json`.
- **builting-router** (renders.mjs): `GET /api/renders/{id}/download` accepts `?format=ifc|glb|obj` query param. Validates format availability against render's `exportFormats`. Delete handler uses prefix-based S3 cleanup (`{userId}/{renderId}/`) to remove all export files.
- **Step Function** (current_json.json): Passes `exportFormats` and `exportFiles` from GenerateIFC → StoreIFC.
- **Lambda memory**: builting-generate increased to 512MB for mesh processing headroom.

### Frontend Changes
- **rendersService.js**: `getDownloadUrl(renderId, format)` accepts format parameter, appends `?format=` query string.
- **renderbox.hbs**: Download button replaced with download group (primary IFC button + chevron for format dropdown). Dropdown shows IFC (BIM Model), glTF (Web / Unreal / Unity), OBJ (Universal 3D).
- **renderbox.css**: Styled download group with split-button design, dropdown positioned above button with dark theme.
- **renderbox.js**: Added `_updateExportFormats(render)` to show/hide chevron and format options based on `render.exportFormats`. `_handleDownload(format)` passes format to service, uses correct file extension. Click-away handler closes dropdown.
- **details.hbs**: Added export format badges section in Model Statistics.
- **details.css**: Styled export badges with accent color for non-IFC formats.
- **details.js**: Populates export format badges in `_displayStats()` from `render.exportFormats`.

### DynamoDB Schema Updates
- `builting-renders` table gains two new optional fields:
  - `exportFormats` (List): e.g. `['IFC4', 'glTF', 'OBJ']`
  - `exportFiles` (Map): e.g. `{ glb: { s3Key, sizeBytes }, obj: { s3Key, sizeBytes } }`

### Files Modified
- `backend/lambda-functions/builting-generate/requirements.txt`
- `backend/lambda-functions/builting-generate/lambda_function.py`
- `backend/lambda-functions/builting-store/index.mjs`
- `backend/lambda-functions/builting-router/renders.mjs`
- `backend/step-function/current_json.json`
- `ui/services/rendersService.js`
- `ui/components/renderbox/renderbox.hbs`
- `ui/components/renderbox/renderbox.css`
- `ui/components/renderbox/renderbox.js`
- `ui/components/details/details.hbs`
- `ui/components/details/details.css`
- `ui/components/details/details.js`

### Deployments (2026-03-15)
- `builting-generate` Docker image rebuilt with trimesh, pushed to ECR, Lambda updated (512MB)
- `builting-store` Lambda zip uploaded
- `builting-router` Lambda zip uploaded
- Step Function definition updated with exportFormats/exportFiles passthrough

---

## Pipeline Overhaul — Phase A+B1: Stage Trace Logging & Roof Deduplication (2026-03-17)

### Phase A: Enhanced Stage Trace Logging
- Added `buildTypeHistogram()` helper to structure lambda — tracks element counts by type including `_SLAB_ROOF` for roof slabs specifically
- Enhanced `timedStep()` to capture before/after type histograms per pipeline step (not just element count deltas)
- Added final trace summary log (`StructureResolve final: {...}`) for CloudWatch observability
- Attached `_stageTrace` to CSS metadata — full step-by-step timing + histogram data persisted in css_structure.json
- Added `finalTypeHistogram` to structure_inference_report.json debug artifact
- Added CSS input histogram logging to generate lambda (`CSS input histogram: {...}`)

### Phase B1: Roof Deduplication
- **Root cause identified**: Two independent paths create roof representations — extract can emit `type: 'ROOF'` elements while structure's `inferSlabs()` marks top-level SLABs with `slabType: 'ROOF'`. Generate maps these to different IFC entities (IfcRoof vs IfcSlab) and only deduplicates same-type+same-position.
- Added `deduplicateRoofs()` function to structure/building-envelope.mjs — removes ROOF elements when a matching SLAB with slabType='ROOF' exists at same position (within 0.5m XY, same container). Keeps SLAB representation (gets material layers in generate).
- Called twice in handler: after `inferSlabs()` and after `guaranteeBuildingEnvelope()` to catch roofs from both sources
- Added cross-type ROOF↔SLAB dedup as defense-in-depth in generate/lambda_function.py (pre-processing, before main element loop)

### Files Modified
- `backend/lambda-functions/builting-structure/index.mjs` — histogram helper, enhanced timedStep, dedup calls, trace metadata
- `backend/lambda-functions/builting-structure/building-envelope.mjs` — deduplicateRoofs function + export
- `backend/lambda-functions/builting-generate/lambda_function.py` — cross-type dedup, input histogram logging

### Deployments (2026-03-17)
- `builting-structure` Lambda zip uploaded and deployed
- `builting-generate` Docker image rebuilt (phase-ab1), pushed to ECR, Lambda updated

---

## Pipeline Overhaul — Phase C: Envelope Generation Fix (2026-03-17)

### Fix: Missing Exterior Walls on Buildings with Interior Partitions
- **Root cause**: `guaranteeBuildingEnvelope()` triggered only when total wall count < 4. Buildings like hospitals have many interior partition walls (>4) but zero exterior walls — envelope generation was skipped entirely.
- **Fix**: Changed trigger to count only walls with `isExternal === true`. Buildings with many interior walls but <4 external walls now get perimeter envelope generated at element bounding box.
- Added `originalExternalWalls` to envelope metadata for observability.
- Enhanced log message to show total vs external wall counts.

### Files Modified
- `backend/lambda-functions/builting-structure/building-envelope.mjs` — envelope trigger fix

### Deployments (2026-03-17)
- `builting-structure` Lambda zip uploaded and deployed

---

## Pipeline Overhaul — Topology Engine Consolidation (2026-03-17)

### Phase 1: Create builting-topology-engine (merged structure + geometry + validate)
- Created `backend/lambda-functions/builting-topology-engine/` with unified handler
- Merged `builting-structure/index.mjs` + `builting-geometry/index.mjs` + `builting-validate/` into single `index.mjs`
- Merged all validation logic (semantic, geometric, topological, structural) into `model-validate.mjs`
- Created `config.mjs` centralizing tolerances, gate definitions, scoring weights, severity defaults
- Created `readiness.mjs` for readiness score evaluation
- Copied and unified shared modules: `shared.mjs`, `building-envelope.mjs`, `tunnel-shell.mjs`, `topology-graph.mjs`, `path-connections.mjs`, `equipment.mjs`, `safety.mjs`, `topology-validate.mjs`, `v2-adapter.mjs`, `validation.mjs`
- Pipeline runs in single memory context: no S3 serialization between structure/geometry/validate stages
- Topology graph passed by reference through all stages

### Phase 2: Tiered vertex snapping (50mm → 150mm)
- `snapWallEndpoints()` in `building-envelope.mjs` implements two-pass snapping:
  - Pass 1: 50mm tolerance for tight joins (T-junctions, L-corners)
  - Pass 2: 150mm tolerance for near-misses (envelope gaps)
- Walls within tolerance share exact vertex coordinates (forced coincidence)
- Fixed missing export: `snapWallEndpoints`, `deriveRoofElevation`, `snapSlabsToWallBases` added to exports

### Phase 3: Parametric height chains
- `deriveRoofElevation()`: Roof Z = max(wall base Z + wall height) for storey — no AI-extracted roof Z
- `snapSlabsToWallBases()`: Floor slab Z = min(wall base Z) for storey — gravity check
- `alignSlabsToWalls()`: Extends slab footprint to match wall bounding box

### Phase 4: Mitre/bevel connection metadata + IfcRelConnectsPathElements enrichment
- `computeWallConnectionAngle()` in `path-connections.mjs`: computes angle between wall axes at shared topology node
- Classifies connections as MITRE (10°–170°), BUTT (~0°/~180° collinear), TEE (~90° perpendicular)
- `connectionAngle` metadata embedded in PATH_CONNECTS relationships
- Generate lambda reads `connectionAngle` and annotates `IfcRelConnectsPathElements.Description` with type and angle
- Tracks mitre joint count in generation output

### Phase 5: Proxy threshold + Pset enrichment (already implemented)
- `resolve_ifc_entity_type()` uses `ALWAYS_PROMOTE` set: WALL, SLAB, COLUMN, BEAM, DOOR, WINDOW, DUCT, PIPE, etc. — never become proxies regardless of confidence
- Pset coverage: `Pset_WallCommon`, `Pset_SlabCommon`, `Pset_DoorCommon`, `Pset_WindowCommon`, `Pset_ColumnCommon`, `Pset_BeamCommon`, `Pset_SpaceCommon`, `Pset_DuctSegmentCommon`, `Pset_TunnelSegmentCommon`
- Added `Pset_ManufacturerTypeInformation` for elements with material/manufacturer/model data
- `IfcRelVoidsElement` + `IfcOpeningElement` intermediary for door/window carving into host walls
- `Pset_SourceProvenance` on every element with confidence, source, evidence basis

### Phase 6: Step function updated
- Replaced 3 separate states (`StructureResolve` → `GeometryBuild` → `ValidateModel`) with single `TopologyEngine` state
- `$.topologyResult` carries both geometry keys (cssS3Key, resolvedS3Key) and validation results (readinessScore, etc.)
- StoreIFC parameters remapped from `$.validationResult.*` and `$.pipelineResult.*` to `$.topologyResult.*`
- Pipeline: Read → Extract → Resolve → TopologyEngine → Generate → Store → SeedSensors

### Files Created
- `backend/lambda-functions/builting-topology-engine/index.mjs`
- `backend/lambda-functions/builting-topology-engine/model-validate.mjs`
- `backend/lambda-functions/builting-topology-engine/config.mjs`
- `backend/lambda-functions/builting-topology-engine/readiness.mjs`
- `backend/lambda-functions/builting-topology-engine/package.json`
- (Plus copied: shared.mjs, building-envelope.mjs, tunnel-shell.mjs, topology-graph.mjs, path-connections.mjs, equipment.mjs, safety.mjs, topology-validate.mjs, v2-adapter.mjs, validation.mjs)

### Files Modified
- `backend/lambda-functions/builting-topology-engine/building-envelope.mjs` — fixed exports
- `backend/lambda-functions/builting-topology-engine/path-connections.mjs` — connection angle computation
- `backend/lambda-functions/builting-generate/lambda_function.py` — mitre metadata in IfcRelConnectsPathElements + Pset_ManufacturerTypeInformation
- `backend/step-function/current_json.json` — consolidated pipeline

---

## Phase 13: Universal Geometry Hardening + Legacy Cleanup

### Geometry Fixes (universal — all render types)
- **3D nearest-segment distance**: Fixed 3 remaining 2D distance scans to include Z component — portal wall z-snap, light fixture wall-mount, equipment axis alignment now all use `sqrt(dx²+dy²+dz²)` instead of `sqrt(dx²+dy²)`. Prevents incorrect nearest-segment selection in inclined tunnels.
- **Wall/Slab/Beam depth cap** (`lambda_function.py`): Extended existing column depth cap to cover WALL, SLAB, and BEAM types. Walls/beams capped at storey height; slabs capped at 15% of storey height. Prevents elements extruding past floor levels in all building renders.
- **Building wall snap tolerance** (`building-envelope.mjs`): Increased SNAP_PASS_2 from 150mm → 300mm and MAX_SHIFT from 200mm → 400mm. Repairs more orphan wall endpoints in loosely-specified building renders.
- **Merged pre-pass loops** (`lambda_function.py`): Combined two separate element iteration loops (`decomposed_branches` + `manifold_rendered_branches`) into one unified loop. No behavioral change — efficiency improvement.

### Lambda Cleanup
- **Deleted 4 dead legacy lambdas**: `builting-structure`, `builting-geometry`, `builting-validate`, `builting-transform` — all superseded by `builting-topology-engine`. Removed from AWS and from CLAUDE.md documentation.

### Deployed
- `builting-topology-engine` — updated zip deployed
- `builting-generate` — updated container image pushed to ECR and deployed
