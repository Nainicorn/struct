- builting-main Lambda deployed
- builting-bedrock-ifc Lambda deployed
- builting-store-ifc Lambda deployed
- builting-read-metadata Lambda deployed
- builting-orchestrator-trigger Lambda deployed
- Step Function (builting-render-state-machine) deployed
- Frontend CRUD system implemented (sidebar, renderbox, details)
- CORS configured in API Gateway
- DynamoDB schema finalized

---

## IFC4 Generator Implementation (2025-02-19)
- Upgraded IFC schema from IFC2X3 to IFC4
- Fixed IfcBuilding envelope: proper 4-wall + floor + roof structure
- Material library (30+ materials with RGB colors)
- Proper IFC element types (IfcWall, IfcSlab, IfcDoor, IfcWindow, IfcEquipment)
- Property sets and quantity sets
- Surface styling with IfcSurfaceStyle/IfcStyledItem
- Building-type-aware envelope geometry (office, warehouse, tunnel, parking, hospital, etc.)
- Ventilation elements, doors, windows with materials
- Equipment type → IFC4 entity mapping
- Enhanced Bedrock prompt for richer JSON spec extraction
- Docker image for Python Lambda (arm64)

---

## VentSim Tunnel IFC Generation (2025-02-19)
- VentSim format detector and parser in builting-bedrock-ifc
- MAIN section parsing: 69 tunnel branches with 3D coords, cross-sections, liner types
- Named space extraction (East Portal, West Portal, Diesel Gen, AC Room, etc.)
- Fan extraction with properties
- Tunnel branch IFC generation: rectangular (IfcRectangleProfileDef) and round (IfcCircleProfileDef)
- Material color coding by liner type
- Property sets with tunnel-specific data

---

## CSS Pipeline Overhaul — Phase 1 + Phase 4 (2026-02-28)
- CSS v1.0 schema: `backend/schemas/css-schema.json` and `backend/schemas/css-v1.0.md`
- Upload finalization endpoint to fix race condition: `POST /api/renders/{id}/finalize`
- Bedrock extraction → CSS format with deterministic element IDs and confidence scores
- IFC Generator rewritten: confidence-based semantic mapping, graded output modes (FULL_SEMANTIC, HYBRID, PROXY_ONLY), CSS→IFC caching, inline validation + self-healing
- New Lambda: `builting-css-pipeline` (ValidateCSS + RepairCSS + NormalizeGeometry)
- Step Function simplified: ReadMetadata → Extract → SaveSnapshot → CSSPipeline → GenerateIFC → StoreIFC
- StoreIFC writes elementCounts, outputMode, cssHash to DynamoDB

---

## VentSim Geometry Bug Fixes (2026-02-28)
Fixed 4 bugs in `builting-bedrock-ifc/index.mjs` that caused a blob shape instead of correct tunnel network:

1. **Extrusion direction** — `geometry.direction` was world-space but Python applies it in element-local space. Fixed to always `{x:0, y:0, z:1}` (local Z); element placement handles world orientation.
2. **refDirection** — Was always `(0,0,1)`; parallel to vertical-branch axis → invalid IFC. Fixed: `|dirZ| < 0.9 → (0,0,1)` else `(1,0,0)`.
3. **Absolute coordinates** — Elements at z≈1290m (mine elevation). Normalized all origins to `(minX,minY,minZ)=0`; real-world offset in `facility.origin`.
4. **Header off-by-one** — Parser used first data row as column header; first branch silently skipped. Fixed to parse MAIN line as header and start data at `mainStartIdx+1`.

- **Deployed**: `builting-bedrock-ifc.zip` ✅

---

## IFC Placement/Storey/Validator Overhaul (2026-03-02)
Fixed 9 critical issues in `builting-json-to-ifc-python/lambda_function.py`:

1. **Spatial placement parenting** — Building's IfcLocalPlacement now references `site.ObjectPlacement` (was incorrectly referencing `proj_lp` directly). Chain: Project → Site → Building → Storeys → Elements.
2. **Storey elevation logic** — Supports cumulative elevation computation when `elevation_m` is missing (uses prev_elevation + prev_height). Validates monotonically increasing. Warns if delta differs from expected `height_m` by > 0.25m. Writes `Pset_StoreyHeight.StoreyHeight` on each storey.
3. **Conditional Z subtraction** — New `metadata.placementZIsAbsolute` flag (default true). Only subtracts storey elevation when flag is true. Median-z heuristic warns if elements appear already storey-relative.
4. **Robust axis/refDirection sanitization** — New `sanitize_axis_ref()` helper: normalizes, detects parallel vectors, Gram-Schmidt orthogonalizes, enforces right-handed basis. Used in all `create_element_placement()` calls.
5. **Normalized extrusion direction** — `create_extrusion()` now normalizes direction vectors via `normalize_vector()` with fallback to (0,0,1). Logs element id/type when fallback used.
6. **IfcWall instead of IfcWallStandardCase** — `SEMANTIC_IFC_MAP['WALL']` changed to `'IfcWall'` (was `'IfcWallStandardCase'` which caused viewer invisibility).
7. **Validator excludes spatial containers** — `validate_ifc()` no longer counts IfcSite/IfcBuilding/IfcBuildingStorey as "missing Representation". Adds direction vector validation (checks norm, parallel axis/ref, extrusion direction).
8. **Improved bbox validation** — Walks parent placement chain for absolute coords. Includes profile bounds (rectangle half-dims, circle radius) and extrusion depth for conservative bbox approximation. Reports `bbox.mode` as `'placement-only'` or `'approx'`.
9. **Sanitization tracking** — `_sanitized_elements` dict tracks which elements had directions fixed. Validator classifies "sanitized upstream" vs "still invalid".

**Schema update**: Added `placementZIsAbsolute` boolean to CSS v1.0 Metadata definition in `backend/schemas/css-schema.json`.

**Test suite rewrite**: `test_ifc4.py` fully rewritten with 8 CSS v1.0 regression tests:
- `test_normalize_vector`, `test_sanitize_axis_ref` (math helpers)
- `test_3storey_elevations` (elevations = [0.0, 3.5, 7.0])
- `test_walls_are_ifc_wall` (no IfcWallStandardCase)
- `test_no_spatial_container_representation_warnings`
- `test_no_invalid_direction_vectors` (degenerate input sanitized)
- `test_placement_chain` (Building relative to Site)
- `test_per_element_proxy_fallback` (one bad element doesn't proxy everything)