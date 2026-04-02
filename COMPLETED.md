# Completed Implementation History

## AWS Infrastructure
- API Gateway (`builting-api`) with full REST resource structure and CORS on all endpoints
- DynamoDB tables: `builting-users` (auth) and `builting-renders` (render metadata, validation fields, export formats)
- DynamoDB table: `builting-sensors` (simulated live sensor readings per render)
- S3 buckets: `builting-data` (raw uploads), `builting-ifc` (generated IFC + glTF + OBJ files)
- Step Function (`builting-state-machine`): Read -> Extract -> Resolve -> TopologyEngine -> Generate -> Store -> SeedSensors
- Single shared IAM role (`builting-role`) with 5 least-privilege policies (logs, dynamodb, s3, stepfunctions, bedrock)
- ECR repository `builting-generate` for Python container Lambda
- CloudWatch log groups for all Lambda functions
- Presigned S3 URLs for IFC download (15-minute expiry) replacing base64 transfer
- ECS/Fargate migration design document (architecture only, not implemented)

## Lambda Pipeline

- **builting-router**: API Gateway request router, centralized auth gate (HMAC-signed tokens, timing-safe verification), CORS validation, user self-only access, render CRUD, presigned URL generation, finalize endpoint (starts Step Function), report endpoint (serves verification_report.json), multi-format download (IFC/glTF/OBJ via `?format=`), sensor endpoints (GET/POST refresh)
- **builting-read**: Reads render metadata from DynamoDB, lists S3 files, ensures `render_revision` defaults for first renders
- **builting-extract**: Multi-format file parsing (PDF, DXF, XLSX, DOCX, VentSim, plaintext, images), multi-pass Bedrock extraction (classify -> geometry -> enrich), vision-based drawing analysis (type-specific prompts for floor plans/elevations/cross-sections/equipment layouts), title block extraction, page role classification, spatial layout assembly (DIRECT_2D/ASSEMBLED_2D/ESTIMATED), multi-page PDF support (up to 5 pages), scale calibration, vision-to-BuildingSpec bridge for drawing-primary renders, component-based confidence model, claims dual-write (Phase 1 v2 pipeline), source fusion (equipment from documents with safety allowlist), refinement context injection, source traceability report, esbuild-bundled (5.8MB)
- **builting-resolve**: Reads claims.json, normalizes units/conventions (ft/in/cm/mm -> meters), groups claims by subject identity (3-signal matching), resolves field conflicts (by confidence + extraction method priority), assigns canonical IDs, writes normalized_claims.json + canonical_observed.json + resolution_report.json + identity_map.json
- **builting-topology-engine**: Consolidated from former structure + geometry + validate lambdas. Runs in single memory context (no S3 serialization between stages). Pipeline: ValidateCSS -> RepairCSS -> NormalizeGeometry -> [TUNNEL] DecomposeTunnelShell -> SnapWallEndpoints (tiered 50mm->150mm) -> BuildTopology -> [BUILDING] MergeWalls -> CleanWallAxes -> InferOpenings -> CreateOpeningRelationships -> InferSlabs -> DeriveRoofElevation -> AlignSlabsToWalls -> SnapSlabsToWallBases -> GuaranteeBuildingEnvelope -> ClampDimensions -> BuildPathConnections (mitre/butt/tee angle computation) -> EquipmentMounting -> AnnotateSweepGeometry -> CSSValidation -> SafetyChecks -> ValidateTopology -> RunFullModelValidation -> v2 Adapter -> Write artifacts to S3
- **builting-generate**: CSS-driven IFC4 generation (Python 3.11 container, 512MB), confidence-based semantic mapping, three output modes (FULL_SEMANTIC/HYBRID/PROXY_ONLY), self-healing proxy-only regeneration on failure, mesh fallback (IfcTriangulatedFaceSet), IfcSweptDiskSolid for circular ducts/pipes, IfcCircleHollowProfileDef for hollow profiles, IfcFacetedBrep for junction helpers, dual Axis+Body representations, IfcRelDefinesByType grouping, IfcRelConnectsPathElements with mitre/butt/tee metadata, IfcDistributionSystem for ventilation/piping, IfcDistributionPort connectivity, branch IfcElementAssembly aggregation, IfcSpace containment, IfcRelSpaceBoundary for tunnel shell boundaries, IfcMaterialLayerSetUsage (confidence-gated), material/style caches for reuse, Blinn specular rendering, type-based color system, equipment size defaults, common Psets (Wall/Slab/Door/Window/Column/Beam/Duct/Space/Tunnel + ManufacturerTypeInformation + SourceProvenance + ApproximationMetadata), quantity sets (Wall/Slab/Space/Duct/Pipe/Column/Door/Window), glTF and OBJ export via trimesh (non-blocking, 30s time-boxed)
- **builting-store**: Updates DynamoDB with IFC path, element counts, output mode, CSS hash, validation fields (readinessScore, exportReadiness, authoringSuitability, etc.), export formats/files, quality score (weighted composite), structural warnings, pipeline version, writes artifact manifest to S3
- **builting-sensors**: Seeds and refreshes simulated live sensor data per render, maps IFC element types to sensor types (IfcSpace->TEMPERATURE, IfcDuctSegment->AIRFLOW, IfcFan/IfcPump->EQUIPMENT_STATUS, IfcColumn/IfcBeam->STRUCTURAL_LOAD), max 20 sensors per type per render

## Frontend Components
- **login**: Login/signup form with email/password validation
- **layout**: Main app container initializing header, sidebar, renderbox, details; sidebar collapse tracking (user toggle + auto at 900px)
- **header**: Top nav bar with user name, logout button, sidebar toggle
- **sidebar**: Previous renders as cards (status indicators, relative timestamps, cached thumbnails, delete button with confirmation, refinement badge)
- **controls**: "New render +" button
- **renderbox**: File upload (up to 15 files with extension validation and preview), text-only input (auto-converts to .txt), render processing display with pipeline progress stages, exponential backoff polling (2s->15s, up to 10 min), 3D IFC viewer (xeokit + web-ifc WASM), element pick chip (type, name, IFC class), thumbnail capture, download group with format dropdown (IFC/glTF/OBJ), refinement input
- **details**: Model quality score (circular progress ring), validation summary checklist, model statistics (IFC class bar chart, export format badges), source contributions (per-file role badges), structural warnings, readiness delta display, scope confidence bar, download report button, source file download, delete render
- **ifc-viewer**: 3D viewer using xeokit SDK, element pick events (mouseclicked -> scene.pick -> metaScene), fires elementPicked/elementPickCleared DOM events

## Frontend Services
- **authService**: Login/signup, session management, cookie-based token (24h expiry)
- **aws**: HTTP wrapper for authenticated API Gateway calls with Bearer token
- **cookieService**: Low-level cookie operations (set, get, delete)
- **rendersService**: Render CRUD, multi-format download (IFC/glTF/OBJ), report download, refine render
- **uploadService**: Presigned URL requests, S3 direct uploads, render finalization
- **usersService**: Fetch current user data (userStore/localStorage first, API fallback)
- **userStore**: Client-side state manager (memory + localStorage backup)
- **modalService**: Confirm/alert modal dialogs
- **sensorService**: Polls GET /sensors (30s interval, visibility-aware pause), POST /sensors/refresh
- **messages**: BroadcastChannel-based event bus for inter-component communication

## IFC Generation Features
- IFC4 schema with full building hierarchy (Site -> Building -> Storey -> Spaces -> Elements)
- Three geometry methods: EXTRUSION (IfcExtrudedAreaSolid), SWEEP (IfcSweptDiskSolid), MESH (IfcTriangulatedFaceSet/IfcFacetedBrep)
- 3-step geometry escalation (normal extrusion -> sanitized extrusion -> mesh fallback)
- Tunnel shell decomposition (rectangular segments -> LEFT_WALL, RIGHT_WALL, FLOOR, ROOF, VOID)
- Stable branch frame for all shell pieces (shared refDirection)
- Shell completeness audit and reconstruction of missing pieces
- Closure-target-based junction extensions and transition plugs
- Shell run merging with true-span origin computation
- Building envelope fallback (generates perimeter walls, floor, roof when missing)
- Opening void geometry (dedicated IfcOpeningElement with IfcRelVoidsElement)
- Equipment mounting (wall/ceiling/floor based on type, origin guard for 0,0,0)
- Curved geometry: IfcSweptDiskSolid for circular ducts/pipes, IfcCircleHollowProfileDef for hollow profiles
- Material library with predefined colors for structural, MEP, equipment, infrastructure, tunnel shell
- Type-based 4-tier color system (semanticType -> shellPiece -> css_type -> material)
- Blinn specular reflectance, glass transparency for windows, void translucency
- BIM connectivity: IfcDistributionSystem (ventilation/piping), IfcDistributionPort (SOURCE/SINK), IfcRelConnectsPorts
- IfcRelDefinesByType grouping by (entity_type, material, profile_key)
- Descriptive element naming with type prefix and context from properties

## Quality & Validation
- 10 readiness gates (8 hard, 2 soft) producing readiness score (0-100)
- Export readiness assessment (hard gates), authoring suitability (FULL_AUTHORING/COORDINATION_ONLY/VIEWER_ONLY/NOT_RECOMMENDED)
- 12-check Revit compatibility validation with letter grade (A/B/C/D/F)
- Semantic validation (confidence distribution, proxy ratio, type alignment, generic name detection)
- Geometric validation (local frame sanity, NaN/Inf/bounds, profile/depth validity, mesh sanity, coincident placement)
- Topological validation (container conventions, relationship integrity, opening host, PATH_CONNECTS coverage)
- Structural validation (minimum viability, shell naming consistency, envelope connectivity)
- Geometry fidelity metrics (nativeCurveRatio, polygonApproxRatio, sweepCount)
- Safety checks (5000 element limit, coordinate bounds +-100km, dimension limits, overlap detection)
- Proxy tracking with categorized reasons (mode, type, confidence, unmapped)
- Engineer audit artifact (verification_report.json) with pipeline stages, quality assessment, compliance checklist, scope boundary
- Readiness delta computation for refinements (previous vs current score)
- Pipeline debug artifacts (extract_debug.json, transform_debug.json, issue_report.json, artifact_manifest.json)
- Stage trace logging with per-step type histograms
- Automated Revit interop test suite and structural fingerprint regression tests

## Sensor System
- DynamoDB `builting-sensors` table with render_id (PK) + sensor_id (SK)
- Sensor seeding maps IFC element types to sensor types (temperature, airflow, equipment status, structural load)
- Simulated live readings with refresh endpoint
- Frontend polling (30s interval, pauses when tab hidden)
- Max 20 sensors per type per render

## Export Formats
- **IFC4**: Primary output, full BIM semantics
- **glTF (.glb)**: Lightweight web/game engine format via trimesh + ifcopenshell.geom (non-blocking, 30s budget)
- **OBJ (.obj)**: Universal 3D format via trimesh (non-blocking, 30s budget)
- Format-aware download endpoint (`?format=ifc|glb|obj`)
- Frontend download dropdown with all available formats
- Conversion guard: skipped when >50k triangles or >500 products

## Universal Pipeline Refactor — Data-Driven Engineering (v2)

**Goal:** Eliminate all hardcoded constants and replace with physics/engineering-derived values. Pipeline works for any structure type (tunnel, hospital, office, warehouse, etc.).

### generate lambda (`lambda_function.py`)
- Added 5 engineering utility functions: `derive_shell_thickness`, `derive_slab_thickness`, `derive_storey_height`, `derive_duct_profile`, `derive_junction_overlap`
- Replaced 8 hardcodes: `max_radius=0.781` (VentSim-specific), duct fallback `1.2×0.8`, `JUNCTION_OVERLAP_M=0.3`, `END_CAP=0.5`, slab depth cap `max_storey_h×0.15`, duct AR `max_side×0.6`, `wt=0.4` shell thickness, `storey_height_map` default 5.0m
- Fixed 4 bugs: shaft_ref empty dict → direction fallback, tunnel_segments_index KeyError guards, `is_placeholder` tolerance widened to 0.05, storey height uses `derive_storey_height(occupancy_type)`
- Engineering basis: concrete shell 8% rule, ASHRAE duct AR ≤4:1/6:1, RC slab span/20-30, junction overlap tan(turn/2) formula

### topology-engine
- **shared.mjs**: Added 6 exported math utilities: `medianSegmentLength`, `structureZRange`, `shellThicknessFromProfile`, `junctionOverlapFromProfile`, `slabThicknessFromSpan`, `storeyHeightFromOccupancy`
- **vsm-bridge.mjs**: `MAX_BRIDGE_LEN` derived from median segment length × 1.5; `UPPER_Z_THRESHOLD` derived from z-range × 0.15; NaN guard on bridge direction; shell thickness from profile
- **tunnel-shell.mjs**: Removed `DEFAULT_WALL_THICKNESS` constant — all thickness via `deriveThickness(W,H)`; min-dimension thresholds data-driven (`< 0.1m` not `<= 0.6m`); `generateJunctionTransitions` uses per-junction derived thickness; domain string check replaced with element-type check
- **building-envelope.mjs**: All 9× `domain === 'TUNNEL'` string checks → `hasTunnelSegments(css)` (data-driven, cached); storey height default from `storeyHeightFromOccupancy(occupancy)`
- **rule-assertions.mjs**: Storey elevation null fix (`!== undefined && !== null`); wall gap check `console.warn`; domain check → element-type check
- **index.mjs**: `hasTunnelSegs` boolean replaces all `domain === 'TUNNEL'` pipeline branching; `annotateSweepGeometry` reads `facilityMeta.upAxis` for default axis; depth fallback reads `facilityMeta.typicalElementDepth` before 1.0m constant

### extract lambda (`index.mjs`)
- Map key collision fix in `buildRefinementReport`: `e.id || e.element_key || e.css_id || \`anon_${i}\``
- DWG warning: `downloadFile` emits `console.warn` for `.dwg` files explaining DWG ≠ DXF and LLM-vision-only fallback
- Richer extraction prompts: `EXTRACTION_SYSTEM_PROMPT` gains "ENGINEERING DERIVATION FIELDS" section instructing Claude to extract structural system type (masonry/concrete/steel/timber), occupancy/function, per-storey heights, wall types (isExternal/isLoadBearing/material), typical element depth, structural cross-section dimensions
- `EXTRACTION_TOOL` schema: added `structuralSystem`, `occupancy`, `typicalElementDepth_m` to the structural section; `isLoadBearing`, `isExternal`, `material` to interior_walls and perimeter_walls items

### Deployed
- topology-engine: `node build-zip.mjs` → `builting-topology-engine.zip` (136KB) → AWS Lambda
- extract: `npm run build` (esbuild, 5.9MB) → targeted zip with sharp native binaries (16MB) → AWS Lambda
- generate: Docker → ECR (deployed in prior session)
