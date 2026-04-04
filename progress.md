# Pipeline Progress

## Phase 0 — Research Complete (2026-04-03)

### Deploy pipeline findings
- `builting-topology-engine`: `node build-zip.mjs` → zip → `aws lambda update-function-code --zip-file`
- `builting-extract`: requires S3 upload path (zip > 50MB) — skipped in auto-deploy hook
- `builting-generate`: Docker/ECR — skipped in auto-deploy hook (separate ECR flow)
- `builting-router`, `builting-read`, `builting-store`, `builting-sensors`, `builting-resolve`: manual zip → direct upload
- AWS profile: `leidos`, region: `us-gov-east-1`, account: `008368474482`

### Z-frame root cause confirmed (Bug #1)
- `normalizeGeometry` (validation.mjs:216): `shiftZ = -minZ`, shifts `placement.origin.z` (line 239)
- Does NOT shift: `levelsOrSegments[].elevation_m`
- Does NOT shift: `geometry.pathPoints` Z (only `geometry.vertices` shifted, lines 256-261)
- Mismatch cascades into: sill height (line 1454), storey-Z check (line 1696), MEP Z

### Other bugs confirmed with line numbers
- Bug #2: building-envelope.mjs:1696 — tolerance uses elevation_m not height_m
- Bug #3: building-envelope.mjs:2073-2076 — wall snap Z not propagated to child openings
- Bug #8: building-envelope.mjs:389 — floor-snap tolerance 0.3m (needs 0.5m)
- Bug #4: index.mjs:273 — `_defaultAxis = {x:0,y:0,z:1}` Z-up fallback
- Bug #5: index.mjs:344-351 — sort ascending only, no travel-direction check
- Bug #9: path-connections.mjs:20-40 — `getElementRunDirection` forces Z=0 in all branches
- Bug #11: repairCSS does not clamp negative elevations (pass-through is correct, audit `|| 0` patterns instead)

### Hook system
- PostToolUse hook config goes in `.claude/settings.local.json` under `hooks` key
- stdin JSON: `{ tool_input: { file_path }, tool_name }`
- No `skills/` or `agents/` dirs existed before Phase 1

---

## Phase 0.5 — DXF Parser Fixes + Generate Placement Fix (2026-04-03)

### Status: COMPLETE

### DXF Parser Fixes (builting-extract, parsers/dxfParser.mjs + dist/index.mjs)
- [x] 0.5.1 Coordinate scale override — INSUNITS=6 (meters) but extents prove mm; auto-detect via $EXTMAX span > 10km → apply ×0.001
- [x] 0.5.2 AIA layer name mapping — A-WALL→WALL, A-FLOR→SLAB, S-COLS→COLUMN patterns added before generic startsWith checks
- [x] 0.5.3 PolyFaceMesh extraction — flag-64 POLYLINE detection, position vertices (flag 192) filtered from face records (flag 128), bounding box footprint emitted as single element

### Generate Placement Bug Fix (builting-generate, lambda_function.py)
- [x] 0.5.4 **Root cause:** `elem_lp` (IFC ObjectPlacement) was created at line 2853 with original CSS placement (axis={0,0,1} = vertical), BEFORE the hollow manifold code at lines 3176-3177 rewrote placement_data with bearing-based axes. Stale placement → every tunnel segment extruded vertically.
- [x] 0.5.5 **Fix:** Moved `elem_lp = create_element_placement(...)` to after all placement_data modifications (hollow manifold, junction overlap, portal buildings). Cache version bumped v33→v34.
- [x] 0.5.6 **Result:** Tunnel segments now render as horizontal hollow tubes along correct bearing. Connected tunnel structure visible with correct turns, junctions, and equipment placement.

### Remaining visual bugs (confirmed, scheduled for later phases)
- Blue vertical MEP lines — Z-up axis fallback (Bug #4, Phase 4.1)
- Staircase appearance at tunnel ends — mitre angle (Bug #9, Phase 5.1)
- Misaligned wall pieces at corners — wall snapping (Bugs #2/#3, Phase 3)
- Floating elements top-right — Z-frame (Bug #1, Phase 2)

---

## Phase 1 — Automation Infrastructure (2026-04-03)

### Status: COMPLETE

### Completed
- [x] 1.1 `.claude/hooks/auto-deploy-lambda.sh` — PostToolUse hook, opt-in guard, skips generate/extract
- [x] 1.1 `.claude/settings.local.json` — `hooks.PostToolUse` config added (async: true, 120s timeout)
- [x] 1.2 `.claude/skills/deploy-lambda/SKILL.md` — covers zip, S3, and ECR paths
- [x] 1.3 `.claude/skills/logs/SKILL.md` — `aws logs tail` with fallback
- [x] 1.4 `.claude/agents/lambda-deployer.md` — full Lambda architecture table, all deploy commands

### Test Results
- topology-engine file edit → hook fires, `node build-zip.mjs` runs, proceeds to deploy ✓
- unrelated UI file → hook exits silently (exit 0, no output) ✓
- builting-generate file → hook skips with JSON message, exit 0 ✓

### Files Created
- `.claude/hooks/auto-deploy-lambda.sh`
- `.claude/skills/deploy-lambda/SKILL.md`
- `.claude/skills/logs/SKILL.md`
- `.claude/agents/lambda-deployer.md`
- `progress.md` (this file)
- `todo.md`

### Modified
- `.claude/settings.local.json` (added `hooks` block)

---

## Phase 2 — Z-Frame Normalization Fix (2026-04-04)

### Status: COMPLETE

### Root cause
`normalizeGeometry` (validation.mjs:233) computes `shiftZ = -minZ` but only shifts `placement.origin.z` and `geometry.vertices.z`. Misses `geometry.pathPoints[].z` and `levelsOrSegments[].elevation_m`, creating a systematic Z-offset between element positions (shifted) and storey elevations / path geometry (unshifted).

### Fix
- [x] 2.1 Added `geometry.pathPoints` XYZ shift in normalizeGeometry (validation.mjs, after vertex shift block)
- [x] 2.2 Added `levelsOrSegments[].elevation_m` shift in normalizeGeometry (after element loop)
- [x] 2.3 Deploy topology-engine + generate (cache bust v34→v35→v36)
- [x] 2.4 Bug #4 partial fix: EXTRUSION ducts with pathPoints + Z-up axis now derive placement axis from path direction (generate lambda_function.py). Blue vertical spikes reduced but not eliminated — full fix in Phase 4.

---

## Phase 3 — Wall Snapping Fixes (2026-04-04)

### Status: COMPLETE

### Fixes (building-envelope.mjs)
- [x] 3.1 Bug #8: Floor-snap tolerance 0.3m → 0.5m (line 389)
- [x] 3.2 Bug #2: Storey-Z tolerance now uses `storeyHeights` (height_m) instead of `storeyElevations` (elevation_m) at line 1696
- [x] 3.3 Bug #3: Wall snap Z-shift propagates to child openings via `hostWallKey` (after line 2076)

### Verification
- Zero storey-Z inconsistency warnings in CloudWatch (confirmed)
- Tunnel render unchanged (expected — these fixes target buildings with doors/windows)

---

---

## Phase 4 — MEP Z-Up Axis Fix (2026-04-04)

### Status: COMPLETE

### What worked
- [x] 4.1 Topology: narrow type-guarded pathPoints direction derivation in `annotateSweepGeometry` (index.mjs:273). Only activates for DUCT/PIPE/CABLE_TRAY when `runDir` is null after full fallback chain. 0 elements hit `_defaultAxis` fallback.
- [x] 4.2 Generate: EXTRUSION duct placement axis override from pathPoints (lambda_function.py ~line 3048). Catches ducts with Z-up axis and horizontal pathPoints.

### What didn't work (reverted)
- `solid_axis_param` for all profile types (was `if True:` instead of `if profile_type in ('ARCH', 'ARBITRARY'):`) — caused regression, broke tunnel segment connectivity by overriding placement-driven orientation on structural elements. Reverted.

### Phase 4 remainder fix (blue spikes)
- [x] 4.3 Generate: Step 12b SWEEP MEP placement normalization (lambda_function.py ~line 2487). For `method='SWEEP'` MEP elements (IfcDuctSegment, IfcPipeSegment, IfcCableCarrierSegment), normalizes placement to identity at pathPoints[0] and transforms pathPoints to relative coordinates. SweptDiskSolid directrix was interpreting world-coordinate pathPoints in the element's local (rotated) frame, causing geometry scramble → vertical spikes. Cache bust v43.

### equipment.mjs:1063 workaround evaluation
**Decision: KEEP.** The Z-alignment at equipment.mjs:1051-1074 is NOT Z-frame compensation — it's duct centerline snapping. It positions AIRWAY ducts at a semantic height within the parent tunnel segment's cross-section (exhaust at 70% height, supply at 60%, intake at 50%). This is correct behavior independent of the Z-frame bug.

---

## Phase 5 — Mitre Joints (2026-04-04)

### Status: COMPLETE

### Bug #9 fix: getElementRunDirection (path-connections.mjs:20-40)
- [x] 5.1 Replaced Z=0 projection with horizontal-magnitude check (hMag > 0.1). Near-vertical vectors (world-up indicators) are skipped; all others return full 3D direction via `vecNormalize(ref)`. Preserves slope info for ramp segments. No behavior change for CSS convention elements (refDirection already horizontal) or VentSim convention (refDirection={0,0,1} falls through to axis correctly).

### Angle-aware junction overlap (lambda_function.py)
- [x] 5.2 Hollow manifold (line ~3215): junction ends now use `node_mitre_angles[node_id]` instead of hardcoded 90°. Terminal ends unchanged (cosmetic cap). `derive_junction_overlap(w, h, actual_angle)` replaces the fixed 0.05m at junctions with geometry-proportional overlap.
- [x] 5.3 Shell pieces (line ~3110): per-end terminal/junction detection via `node_to_segs_for_clip` + `properties.derivedFromBranch`. Terminal ends get 0 overlap (no adjacent panel). Junction ends get angle-aware overlap. Origin shift uses entry overlap only (asymmetric). Bookkeeping updated for mitre clip pass consistency.
- [x] 5.4 Cache bust v44.

### Deployment
- topology-engine deployed FIRST (corrected direction vectors from Bug #9 fix)
- generate deployed SECOND (depends on corrected topology output)

---

## Phase 6 — Z Separation Fix + Shell Roof Closure (2026-04-04)

### Status: COMPLETE

### Z separation (defense-in-depth)
- [x] 6.1 Generate lambda already creates single storey at elevation 0 for all tunnel elements (lines 1665-1687, `has_tunnel_segments` branch). Confirmed in IFC output: `IFCBUILDINGSTOREY(...,0.)`. The Z separation was from a cached render before this code was deployed.
- [x] 6.2 Defense-in-depth: `splitTunnelSubSegments` (vsm-bridge.mjs:76) now sets `elevation_m: 0` instead of `maxUpperZ`. Eliminates the mismatch even if generate's tunnel detection fails.

### Shell roof closure — 4-panel decomposition
- [x] 6.3 Root cause: web-ifc doesn't render IfcRectangleHollowProfileDef correctly — missing roof face creates "open-top channel" appearance. Confirmed: 31 hollow profiles existed in the IFC with correct wallThickness=0.3, but viewer showed roofless channels.
- [x] 6.4 Fix: replaced hollow manifold path with explicit 4-panel shell decomposition in generate (lambda_function.py ~lines 3262-3293). Each rectangular TUNNEL_SEGMENT now creates 4 IfcExtrudedAreaSolid items (LEFT_WALL, RIGHT_WALL, FLOOR, ROOF) with IfcRectangleProfileDef, combined into a single IfcShapeRepresentation.
- [x] 6.5 Cache bust v45→v48. Topology-engine deployed first, generate second.

### Panel rotation regression (v46/v47 — reverted)
- v46 attempted to rotate panel offsets to world space by setting solid axes to bearing — caused full scatter regression (elements lost all connectivity).
- v47 attempted to set solid Axis=(rx_x,rx_y,0) on each panel — also scattered.
- Both reverted. v48 is exact v45 panel code (identity solid axes) with fresh cache salt.
- **Known remaining issue**: panel offsets use identity solid axes `(0,0,1)/(1,0,0)`, so LEFT_WALL/RIGHT_WALL splay outward on angled segments (the offset is along world Y, not the tunnel's lateral axis). Horizontal segments look correct. Needs investigation before next fix attempt.

### IFC analysis (from v45 output)
Dumped actual IfcAxis2Placement3D values from two segments:
- **Branch_1688** (bearing `axis=(0,1,0)`): panels at `(0,±2.35,0)` — correct (lateral = world X)
- **Branch_1689** (bearing `axis=(0.707,0.707,0)`): panels ALSO at `(0,±2.35,0)` — wrong (lateral should be rotated 45°)
- Root cause confirmed: solid Position offsets are interpreted in the solid's OWN coordinate system (identity = world-aligned), not in the element's rotated ObjectPlacement frame. Fix must transform offsets into the solid's frame, but previous attempts (v46/v47) overcorrected.

### Current baseline (v48)
- Cache salt: `__v48_revert_to_v45`
- CloudWatch cache hash: `5402a831738f...`
- IFC entity counts: 169 IfcExtrudedAreaSolid, 165 IfcRectangleProfileDef, 0 IfcRectangleHollowProfileDef
- Visual: connected tunnel with roof panels visible, but angled segments have splayed walls
- This is the stable baseline — do not iterate without IFC-data-driven verification
