# Completed Implementation History

## Backend Hardening Phase 3 — Env Var Portability (2026-03-10)
- All Lambdas: removed `{ region: 'us-east-1' }` from SDK clients (runtime provides `AWS_REGION`)
- All Lambdas: hardcoded bucket/table names → `process.env.X || 'default'` pattern
- `builting-router`: `SESSION_SECRET`, `USERS_TABLE`, `RENDERS_TABLE`, `DATA_BUCKET`, `IFC_BUCKET`, `STATE_MACHINE_ARN`, `ALLOWED_ORIGINS`
- `builting-read`: `RENDERS_TABLE`
- `builting-store`: `RENDERS_TABLE`, `IFC_BUCKET`
- `builting-generate`: `DATA_BUCKET`, `IFC_BUCKET` (Python)
- `ui/services/aws.js`: API Gateway URL moved to `API_BASE_URL` constant
- Fixed `renders.mjs` self-referencing bug: `DATA_BUCKET = process.env.DATA_BUCKET || DATA_BUCKET` → `|| 'builting-data'`
- Fixed `users.mjs` missing env var: hardcoded `'builting-users'` → `process.env.USERS_TABLE || 'builting-users'`
- Fixed `lambda_function.py` line 1284: last remaining `bucket = 'builting-ifc'` → `bucket = IFC_BUCKET`
- All 5 Node.js Lambda zips rebuilt in their respective folders
- Docker image rebuilt + pushed for `builting-generate`

## Backend Hardening Phase 2 — Render Lifecycle (2026-03-10)
- `renders.mjs`: `createRender()` status `pending` → `uploading`
- `renders.mjs`: `finalizeRender()` uses DynamoDB conditional update (`ConditionExpression: status = uploading`) for idempotency — no duplicate Step Functions
- `renders.mjs`: `finalizeRender()` fails fast with 500 if `STATE_MACHINE_ARN` not set
- Status model: `uploading` → `processing` → `completed`/`failed`
- `builting-store-ifc` already sets `completed`/`failed` correctly — no changes needed

## Backend Hardening Phase 1 — Trust-Boundary Cleanup (2026-03-10)

### IAM Consolidation
- Consolidated 2 roles (`builting-lambda-role`, `builting-lambda-execution-role`) → 1 role (`builting-role`)
- 5 custom least-privilege policies: `builting-logs`, `builting-dynamodb`, `builting-s3`, `builting-stepfunctions`, `builting-bedrock`
- All 7 Lambdas updated to use `builting-role`

### Auth Hardening (auth.mjs)
- Password hashing with `crypto.scrypt` (FIPS-compatible, zero deps)
- HMAC-signed tokens: `userId.timestamp.hmac` format using `SESSION_SECRET`
- `verifyToken()` with timing-safe comparison
- `getUserIdFromCookies()` checks `Authorization: Bearer <token>` header first (cross-origin), falls back to cookie

### Centralized Auth Gate (index.mjs)
- OPTIONS preflight always passes — no auth
- `/api/auth` POST is public — no auth
- All other routes require valid token → `event._authenticatedUserId`
- CORS: `ALLOWED_ORIGINS` env var, no wildcard fallback

### User Access Control (users.mjs)
- Self-only access: `requestedId !== event._authenticatedUserId` → 401

### Render Auth (renders.mjs)
- Uses `event._authenticatedUserId` instead of `queryStringParameters.userId`

### Upload Validation (uploads.mjs)
- Uses `event._authenticatedUserId` instead of request body userId
- Extension allowlist: `.txt`, `.pdf`, `.xlsx`, `.xls`, `.docx`, `.dxf` (parser-verified)
- Path traversal, control char, filename length (255), file count (20) checks

### Frontend Auth Updates
- `authService.js`: stores token in cookie + user in `userStore`; clears both on logout
- `usersService.js`: uses `userStore`/localStorage first, falls back to `/api/auth` GET validation
- `aws.js`: sends `Authorization: Bearer <token>` header (cross-origin cookies don't work)
- `rendersService.js`: removed `?userId=` from all endpoints
- `uploadService.js`: removed `userId` from POST body

---

## IFC Placement/Storey/Validator Overhaul (2026-03-02)
- Fixed placement chain (Building→Site), storey elevation logic
- Conditional Z subtraction with `placementZIsAbsolute` flag
- Axis/refDirection sanitization, IfcWall (not StandardCase)
- Validator excludes spatial containers, improved bbox with profile bounds
- 8 CSS v1.0 regression tests

---

## VentSim Geometry Bug Fixes (2026-02-28)
- Fixed extrusion direction, refDirection, coordinate normalization, header parsing
- Tunnel now renders as correct flat network

---

## CSS Pipeline Overhaul Phase 1+4 (2026-02-28)
- CSS v1.0 schema, upload finalization
- Confidence-based IFC generation
- `builting-css-pipeline` Lambda (consolidated 6 steps)
- Simplified Step Function

---

## Phase 6: IFC Quality Improvements (2026-03-03)

### 6A: Wall Alignment + Merging
- `mergeWalls()` in CSS pipeline: snaps direction to cardinal axis within 5 deg, merges collinear walls
- Merge criteria: angle < 3 deg, endpoints within 0.05m, same thickness within 10%, same storey
- Provenance: `metadata.mergedFrom` with original element_keys

### 6B: Opening Inference (Doors/Windows)
- `inferOpenings()` in CSS pipeline: matches DOOR/WINDOW to nearest WALL on same storey (0.5m threshold)
- Sets `metadata.hostWallKey` on matched openings; unmatched kept as-is

### 6C: Slab Inference
- `inferSlabs()` in CSS pipeline: assigns `properties.slabType` = FLOOR or ROOF based on storey position

### 6D: Mesh Fallback
- 3-step escalation in `create_element_geometry()`: normal extrusion, sanitized extrusion, IfcTriangulatedFaceSet mesh
- Tracks fallback type in `metadata.geometryFallbacks`

### 6E: Viewer Compatibility Validation
- Enhanced `validate_ifc()`: NaN/Inf directions, large coordinates (>1e6), storey containment, missing Body rep
- `compatibilityScore` (0-100), `meshFallbackCount`, `proxyFallbackCount` in report

---

## Phase 5: Testing, CI, Bundling (2026-03-03)
- Vitest setup for `builting-bedrock-ifc` and `builting-css-pipeline`
- 34 tests in `builting-bedrock-ifc` (18 parser + 16 enrichment)
- 8 tests in `builting-css-pipeline`
- esbuild bundling: `npm run build` → 5.7MB minified, 1.6MB zip
- GitHub Actions CI

---

## Phase 3: XLSX/DOCX File Format Support (2026-03-03)
- New parser: `parsers/xlsxParser.mjs` — XLSX text extraction
- New parser: `parsers/docxParser.mjs` — DOCX text extraction via mammoth

---

## Phase 2A: DXF Geometry Support (2026-03-03)
- New parser: `parsers/dxfParser.mjs` (~300 lines) — DXF→CSS v1.0 conversion
- PROXY-first approach, semantic upgrades for WALL/COLUMN/SLAB
- INSERT block expansion with recursion/cycle limits

---

## Phase 2B: Multi-pass Bedrock + Enrichment (2026-03-03)
- `enrichCSS()`: Bedrock-powered enrichment with strict whitelist
- Multi-pass Bedrock extraction (Classify → Geometry → Semantics)

---

## VentSim Tunnel Parser (2025-02-19)
- MAIN section parsing, 69 branches, fans, named spaces

---

## IFC4 Generator (2025-02-19)
- Full IFC4 schema, materials, property sets, building-type geometry
- Docker image for Python Lambda (arm64)

---

## Initial Deployment
- All Lambda functions deployed
- Step Function deployed
- Frontend CRUD system (sidebar, renderbox, details)
- CORS configured in API Gateway
- DynamoDB schema finalized
