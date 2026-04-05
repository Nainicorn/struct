/**
 * Topology Engine Lambda (builting-topology-engine)
 *
 * Consolidated from builting-structure + builting-geometry + builting-validate.
 * Runs the entire structural inference, geometry build, and validation pipeline
 * in a single memory context — no intermediate S3 serialization. The topology
 * graph (connectivity graph) is passed by reference through all stages.
 *
 * Pipeline:
 *   ValidateCSS → RepairCSS → NormalizeGeometry →
 *   [TUNNEL] DecomposeTunnelShell pipeline →
 *   [TUNNEL] SplitTunnelSubSegments (main/upper Z-grouping) →
 *   SnapWallEndpoints (tiered: 50mm → 150mm) →
 *   [TUNNEL] BridgeVSMNodes (close coordinate gaps between VSM branches) →
 *   [BUILDING] MergeWalls → CleanWallAxes → BuildTopology →
 *   InferOpenings → CreateOpeningRelationships → InferSlabs →
 *   DeriveRoofElevation → AlignSlabsToWalls → GuaranteeBuildingEnvelope →
 *   ClampDimensions →
 *   BuildPathConnections → EquipmentMounting → AnnotateSweepGeometry →
 *   [TUNNEL] FixRampOrientation (slope axis for segments with |ΔZ| > 0.5m) →
 *   CSSValidation → SafetyChecks → ValidateTopology →
 *   RunFullModelValidation →
 *   v2 Adapter (inferred.json + resolved.json + css_processed.json) →
 *   Write all artifacts to S3
 *
 * Input:  { cssS3Key, userId, renderId, bucket, renderRevision, previousValidationReportS3Key }
 * Output: { cssS3Key, resolvedS3Key, validationReportS3Key, readinessScore, ... }
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

// ── Structure modules ──
import { validateCSS, repairCSS, normalizeGeometry } from './validation.mjs';
import {
  decomposeTunnelShell, validateTunnelGeometry,
  auditGeometryGaps, auditVisualGeometryQuality, auditOrphansAndBridgeGaps,
  generatePortalEndWalls
} from './tunnel-shell.mjs';
import { buildTopologyGraph } from './topology-graph.mjs';
import {
  mergeWalls, inferOpenings, createOpeningRelationships,
  validateOpeningPlacement, inferSlabs, guaranteeBuildingEnvelope,
  cleanBuildingWallAxes, checkEnvelopeFallback, validateBuildingStructure,
  clampAbsurdDimensions, clampWallsToEnvelope, snapWallEndpoints, alignSlabsToWalls,
  countAmbiguousProfiles, resetAmbiguousProfileCount, getAmbiguousProfileCount,
  deduplicateRoofs, deriveRoofElevation, snapSlabsToWallBases, snapWallsToStoreyFloor,
  mergeShortTunnelSegments, validateSpaceContainment, inferSpaces
} from './building-envelope.mjs';

// ── Geometry modules ──
import { buildPathConnections } from './path-connections.mjs';
import { applyEquipmentMounting } from './equipment.mjs';
import { validateCSSElements, runSafetyChecks } from './safety.mjs';
import { validateTopology } from './topology-validate.mjs';

// ── Validation modules ──
import { runFullValidation } from './model-validate.mjs';
import { runRuleAssertions } from './rule-assertions.mjs';

// ── v2 Adapters ──
import { cssToInferred, cssToResolved, resolvedToLegacyCss } from './v2-adapter.mjs';

// ── VSM / Tunnel bridge steps (TUNNEL domain only) ──
import { splitTunnelSubSegments, bridgeVSMNodes, fixRampOrientation } from './vsm-bridge.mjs';

const s3 = new S3Client({});

function buildTypeHistogram(elements) {
  if (!elements) return {};
  const counts = {};
  for (const e of elements) {
    const t = e.type || 'UNKNOWN';
    counts[t] = (counts[t] || 0) + 1;
    if (t === 'SLAB' && e.properties?.slabType === 'ROOF') {
      counts['_SLAB_ROOF'] = (counts['_SLAB_ROOF'] || 0) + 1;
    }
  }
  return counts;
}

// ============================================================================
// UNIVERSAL GEOMETRY CONTRACT
// ============================================================================

/**
 * Classify every element's geometry behavior. This is the backbone of the
 * universal geometry contract — behavior-based, not element-name-based.
 *
 * Behaviors:
 *   PATH_SWEEP         — path-authored: directrix centerline + cross-section profile
 *   PROFILE_EXTRUSION  — profile extruded along a single direction
 *   TESSELLATED        — triangulated/faceted mesh
 *   OPENING_HOSTED     — void-cut element hosted in a parent
 *   SPATIAL            — bounding volume only (no physical geometry)
 *   DISCRETE_SOLID     — standalone solid with identity placement
 */
function classifyGeometryBehavior(css) {
  if (!css.elements) return;

  const PATH_SWEEP_TYPES = new Set(['DUCT', 'PIPE', 'CABLE_TRAY']);
  const PATH_SWEEP_SEMANTICS = new Set(['IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment']);
  const SURFACE_TYPES = new Set(['WALL', 'SLAB', 'COLUMN', 'BEAM']);
  let counts = {};

  for (const elem of css.elements) {
    const geom = elem.geometry;
    if (!geom) continue;

    const type = (elem.type || '').toUpperCase();
    const st = elem.semanticType || '';
    const props = elem.properties || {};
    const meta = elem.metadata || {};
    const method = (geom.method || '').toUpperCase();
    const pp = geom.pathPoints;
    const hasValidPath = Array.isArray(pp) && pp.length >= 2;

    let behavior;

    // 1. TUNNEL_SEGMENT (structural) → PATH_SWEEP with _isTunnelShell flag
    if (type === 'TUNNEL_SEGMENT' && props.branchClass === 'STRUCTURAL') {
      behavior = 'PATH_SWEEP';
      geom._isTunnelShell = true;
    }
    // 2. Explicit linear MEP types → PATH_SWEEP
    else if (PATH_SWEEP_TYPES.has(type) || PATH_SWEEP_SEMANTICS.has(st)) {
      behavior = 'PATH_SWEEP';
    }
    // 3. WALL/SLAB/COLUMN/BEAM with pathPoints → PATH_SWEEP (curved walls, ramps)
    else if (SURFACE_TYPES.has(type) && hasValidPath) {
      // Check pathLength > profile_max_dimension * 2
      const profile = geom.profile || {};
      const maxDim = Math.max(profile.width || 0, profile.height || 0, (profile.radius || 0) * 2, 0.1);
      const pathLen = _computePathLength(pp);
      if (pathLen > maxDim * 2) {
        behavior = 'PATH_SWEEP';
      } else {
        behavior = 'PROFILE_EXTRUSION';
      }
    }
    // 4. Standard surface types → PROFILE_EXTRUSION
    else if (SURFACE_TYPES.has(type)) {
      behavior = 'PROFILE_EXTRUSION';
    }
    // 5. Doors/windows with host → OPENING_HOSTED
    else if ((type === 'DOOR' || type === 'WINDOW') && (meta.hostWallKey || props.hostWallKey)) {
      behavior = 'OPENING_HOSTED';
    }
    // 6. Spaces → SPATIAL
    else if (type === 'SPACE') {
      behavior = 'SPATIAL';
    }
    // 7. Mesh/BREP → TESSELLATED
    else if (method === 'MESH' || method === 'BREP') {
      behavior = 'TESSELLATED';
    }
    // 8. Default → DISCRETE_SOLID
    else {
      behavior = 'DISCRETE_SOLID';
    }

    geom._geoBehavior = behavior;
    counts[behavior] = (counts[behavior] || 0) + 1;
  }

  console.log(`classifyGeometryBehavior: ${JSON.stringify(counts)}`);
}

/** Compute total path length from an array of {x,y,z} points. */
function _computePathLength(pathPoints) {
  let len = 0;
  for (let i = 1; i < pathPoints.length; i++) {
    const p0 = pathPoints[i - 1], p1 = pathPoints[i];
    const dx = (p1.x || 0) - (p0.x || 0);
    const dy = (p1.y || 0) - (p0.y || 0);
    const dz = (p1.z || 0) - (p0.z || 0);
    len += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return len;
}

/**
 * [TUNNEL] After decomposeTunnelShell assigns elem-* keys to TUNNEL_SEGMENT
 * elements, remap stale VSM branch ID container refs on ALL elements to the
 * new element_key values.
 *
 * VentSim equipment/child elements may arrive with container refs pointing to
 * the original VentSim branch ID (e.g. "ventsim_branch_260") rather than the
 * canonical levelsOrSegments entry or the resolved element_key. After
 * decomposeTunnelShell assigns element_key via elemId(), the old branch ID
 * no longer matches anything in buildSegmentIndex — causing findParentSegment
 * to fall through to projection-only matching, and leaving stale refs that
 * trigger invalid_container_ref in model-validate.
 *
 * Reverse-lookup sources (all checked):
 *   • elem.id → elem.element_key          (original id before key assignment)
 *   • properties.vsm_id → element_key     (explicit VSM ID field, if present)
 *   • "ventsim_branch_N" → element_key    (constructed from properties.unique_no)
 */
function remapVSMContainerRefs(css) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  if (!css.elements) return;

  // Build reverse lookup: old VSM id → new element_key
  const vsmIdToElemKey = new Map();
  for (const e of css.elements) {
    if (e.type !== 'TUNNEL_SEGMENT') continue;
    if (!e.element_key) continue;
    // Map original id → element_key (covers hash-based ids that were renamed)
    if (e.id && e.id !== e.element_key) vsmIdToElemKey.set(e.id, e.element_key);
    // Map explicit vsm_id property (if present in properties)
    if (e.properties?.vsm_id) vsmIdToElemKey.set(e.properties.vsm_id, e.element_key);
    // Map ventsim_branch_N alias constructed from unique_no
    if (e.properties?.unique_no != null) {
      vsmIdToElemKey.set(`ventsim_branch_${e.properties.unique_no}`, e.element_key);
    }
  }

  if (vsmIdToElemKey.size === 0) return;

  const validContainerIds = new Set((css.levelsOrSegments || []).map(l => l.id));

  let remapped = 0, unresolved = 0;
  for (const e of css.elements) {
    const cb = e.container;
    if (!cb || validContainerIds.has(cb)) continue; // already valid or absent
    const newKey = vsmIdToElemKey.get(cb);
    if (newKey) {
      e.container = newKey;
      remapped++;
    } else {
      // Stale ref that couldn't be resolved — warn for inspection
      unresolved++;
      console.warn(`CONTAINER_REF_REMAP: unresolved ref "${cb}" on ${e.type} ${e.id || e.element_key || 'unknown'}`);
    }
  }

  console.log(`CONTAINER_REF_REMAP: remapped=${remapped}, unresolved=${unresolved}`);
}

/**
 * Path-author all PATH_SWEEP elements: ensure they have validated pathPoints,
 * _runAxis, and _pathLength. Does NOT force geometry.method = 'SWEEP' —
 * the generator chooses the best IFC representation.
 */
function annotateSweepGeometry(css) {
  if (!css.elements) return;

  let annotated = 0;
  let depthFallbackCount = 0;
  const MAX_PATH_POINTS = 200;

  // Derive default up-axis from facilityMeta rather than hardcoding Z-up
  const facilityUp = css.facilityMeta?.upAxis || css.metadata?.facilityMeta?.upAxis;
  const _defaultAxis = facilityUp === 'Y' ? { x: 0, y: 1, z: 0 }
                     : facilityUp === 'X' ? { x: 1, y: 0, z: 0 }
                     : { x: 0, y: 0, z: 1 };
  if (!facilityUp) console.log('annotateSweepGeometry: no upAxis in facilityMeta — defaulting to Z-up');

  for (const elem of css.elements) {
    const geom = elem.geometry;
    if (!geom) continue;
    if (geom._geoBehavior !== 'PATH_SWEEP') continue;
    if (geom._isTunnelShell) continue; // tunnel shell placement handled by generate

    // Already path-authored with valid data — skip
    if (geom._pathAuthored && Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) continue;

    const placement = elem.placement || {};
    const origin = placement.origin || { x: 0, y: 0, z: 0 };

    // Determine run axis: refDirection (CSS convention: axis=world-up, refDirection=bearing)
    // upAxis from facilityMeta drives the default — fall back to Z-up only if unspecified.
    const MEP_TYPES = new Set(['DUCT', 'PIPE', 'CABLE_TRAY']);
    let runDir = placement.refDirection || geom.direction || placement.axis;
    if (!runDir && MEP_TYPES.has((elem.type || '').toUpperCase())
        && Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) {
      const p0 = geom.pathPoints[0], p1 = geom.pathPoints[geom.pathPoints.length - 1];
      const dx = (p1.x || 0) - (p0.x || 0), dy = (p1.y || 0) - (p0.y || 0), dz = (p1.z || 0) - (p0.z || 0);
      const pLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (pLen > 0.001) runDir = { x: dx / pLen, y: dy / pLen, z: dz / pLen };
    }
    if (!runDir) runDir = _defaultAxis;
    const typicalDepth = css.facilityMeta?.typicalElementDepth || css.metadata?.facilityMeta?.typicalElementDepth;
    const depth = geom.depth || typicalDepth || 1.0;
    if (!geom.depth) depthFallbackCount++;
    if (depth <= 0) continue;

    const ax = runDir.x || 0, ay = runDir.y || 0, az = runDir.z || 0;
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-10) continue;
    const nx = ax / len, ny = ay / len, nz = az / len;

    // Generate pathPoints if missing
    if (!Array.isArray(geom.pathPoints) || geom.pathPoints.length < 2) {
      geom.pathPoints = [
        { x: origin.x - nx * depth / 2, y: origin.y - ny * depth / 2, z: origin.z - nz * depth / 2 },
        { x: origin.x + nx * depth / 2, y: origin.y + ny * depth / 2, z: origin.z + nz * depth / 2 }
      ];
      geom._previousMethod = geom.method || 'EXTRUSION';
    }

    // Validate and clean pathPoints
    geom.pathPoints = _validatePathPoints(geom.pathPoints, MAX_PATH_POINTS);

    if (geom.pathPoints.length < 2) continue; // validation removed all points

    // Check minimum path length
    const profile = geom.profile || {};
    const maxDim = Math.max(profile.width || 0, profile.height || 0, (profile.radius || 0) * 2, 0.1);
    const pathLen = _computePathLength(geom.pathPoints);
    if (pathLen <= maxDim * 2) {
      // Too short — downgrade to DISCRETE_SOLID
      geom._geoBehavior = 'DISCRETE_SOLID';
      geom._pathAuthored = false;
      continue;
    }

    // Store path metadata
    geom._pathAuthored = true;
    geom._runAxis = { x: nx, y: ny, z: nz };
    geom._pathLength = pathLen;
    annotated++;
  }

  if (annotated > 0 || depthFallbackCount > 0) {
    const typicalDepth = css.facilityMeta?.typicalElementDepth || css.metadata?.facilityMeta?.typicalElementDepth;
    const fallbackSrc = typicalDepth ? `facilityMeta.typicalElementDepth=${typicalDepth}` : '1.0m constant (no facilityMeta.typicalElementDepth)';
    console.log(`annotateSweepGeometry: ${annotated} PATH_SWEEP elements path-authored; ${depthFallbackCount} used depth fallback → ${fallbackSrc}`);
  }
}

/**
 * Validate and clean pathPoints: sort along dominant axis, dedupe,
 * remove zero-length segments, enforce max count.
 */
function _validatePathPoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length < 2) return points;

  // Remove non-finite points
  let clean = points.filter(p =>
    Number.isFinite(p.x || 0) && Number.isFinite(p.y || 0) && Number.isFinite(p.z || 0)
  );

  if (clean.length < 2) return clean;

  // Sort along dominant axis (ensure consistent start→end direction)
  // Determine dominant axis from first-to-last vector
  const p0 = clean[0], pN = clean[clean.length - 1];
  const dx = Math.abs((pN.x || 0) - (p0.x || 0));
  const dy = Math.abs((pN.y || 0) - (p0.y || 0));
  const dz = Math.abs((pN.z || 0) - (p0.z || 0));
  // Only sort if points might be unordered (more than 2 points)
  if (clean.length > 2) {
    if (dx >= dy && dx >= dz) {
      clean.sort((a, b) => (a.x || 0) - (b.x || 0));
    } else if (dy >= dx && dy >= dz) {
      clean.sort((a, b) => (a.y || 0) - (b.y || 0));
    } else {
      clean.sort((a, b) => (a.z || 0) - (b.z || 0));
    }
  }

  // Remove duplicate points (within 1mm tolerance)
  const DEDUP_TOL = 0.001;
  const deduped = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const prev = deduped[deduped.length - 1];
    const cur = clean[i];
    const dist = Math.sqrt(
      ((cur.x || 0) - (prev.x || 0)) ** 2 +
      ((cur.y || 0) - (prev.y || 0)) ** 2 +
      ((cur.z || 0) - (prev.z || 0)) ** 2
    );
    if (dist > DEDUP_TOL) {
      deduped.push(cur);
    }
  }

  // Remove zero-length segments (min 10mm)
  const MIN_SEG = 0.01;
  const filtered = [deduped[0]];
  for (let i = 1; i < deduped.length; i++) {
    const prev = filtered[filtered.length - 1];
    const cur = deduped[i];
    const dist = Math.sqrt(
      ((cur.x || 0) - (prev.x || 0)) ** 2 +
      ((cur.y || 0) - (prev.y || 0)) ** 2 +
      ((cur.z || 0) - (prev.z || 0)) ** 2
    );
    if (dist >= MIN_SEG) {
      filtered.push(cur);
    }
  }

  // Enforce max pathPoints (performance guard)
  if (filtered.length > maxPoints) {
    // Subsample evenly
    const step = filtered.length / maxPoints;
    const sampled = [filtered[0]];
    for (let i = 1; i < maxPoints - 1; i++) {
      sampled.push(filtered[Math.round(i * step)]);
    }
    sampled.push(filtered[filtered.length - 1]);
    return sampled;
  }

  return filtered;
}

export const handler = async (event) => {
  console.log('TopologyEngine Lambda invoked — unified structure + geometry + validate');
  resetAmbiguousProfileCount();
  const startTime = Date.now();
  const stepTimings = [];

  // The CSS object is passed by reference through ALL stages — no serialization.
  let css;

  function timedStep(name, fn) {
    const t0 = Date.now();
    const elementsBefore = css?.elements?.length || 0;
    const typesBefore = buildTypeHistogram(css?.elements);
    fn();
    const ms = Date.now() - t0;
    const elementsAfter = css?.elements?.length || 0;
    const typesAfter = buildTypeHistogram(css?.elements);
    stepTimings.push({ step: name, durationMs: ms, elementsBefore, elementsAfter, typesBefore, typesAfter });
    if (ms > 50 || elementsBefore !== elementsAfter) {
      console.log(`Step ${name}: ${ms}ms (${elementsBefore}→${elementsAfter} elements)`);
    }
  }

  const { cssS3Key, userId, renderId, bucket, renderRevision, previousValidationReportS3Key } = event;
  const revision = renderRevision || 1;

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 1: LOAD CSS FROM S3
  // ════════════════════════════════════════════════════════════════════════

  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cssS3Key }));
    css = JSON.parse(await response.Body.transformToString());
    console.log(`Loaded CSS from S3: ${cssS3Key} (${css.elements?.length || 0} elements)`);
  } catch (err) {
    console.error('Failed to load CSS from S3:', err.message);
    throw new Error(`Failed to load CSS from S3: ${err.message}`);
  }

  if (!css || !css.elements) {
    throw new Error('CSS loaded from S3 has no elements');
  }

  // Idempotency: if output artifacts already exist, return cached result
  const _processedKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
  const _engineReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/topology_engine_report.json`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: _processedKey }));
    console.log(`[idempotency] css_processed.json exists — returning cached result`);
    const engineObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: _engineReportKey }));
    const engineReport = JSON.parse(await engineObj.Body.transformToString());
    const mv = engineReport.modelValidation || {};
    return {
      cssS3Key: _processedKey,
      resolvedS3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/resolved.json`,
      validationReportS3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/validation_report.json`,
      readinessScore: mv.readinessScore || 0,
      exportReadiness: mv.exportReadiness || 'NOT_READY',
      authoringSuitability: mv.authoringSuitability || null,
      criticalIssueCount: mv.errorCount || 0,
      warningCount: mv.warningCount || 0,
      proxyRatio: mv.proxyRatio || 0,
      generationModeRecommendation: mv.generationMode || null,
      readinessDelta: 0,
      geometryFidelity: mv.geometryFidelity || null,
      inferredS3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/inferred.json`,
      elementCount: engineReport.elementCountOut || 0,
      domain: engineReport.domain || 'UNKNOWN',
      validationResult: {
        valid: engineReport.cssValidation?.valid || false,
        errorCount: engineReport.cssValidation?.errorCount || 0,
        warningCount: engineReport.cssValidation?.warningCount || 0,
        errors: [],
        warnings: [],
      },
      topology_report: null,
    };
  } catch (err) {
    if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) throw err;
  }

  const elementCountIn = css.elements.length;
  const domain = (css.domain || '').toUpperCase();
  // Data-driven: pipeline branching is determined by element types, not the domain string.
  // This correctly handles hybrid structures and cases where domain is missing or wrong.
  const hasTunnelSegs = css.elements.some(e => e.type === 'TUNNEL_SEGMENT');
  console.log(`TopologyEngine: domain=${domain}, hasTunnelSegs=${hasTunnelSegs}, elementCount=${elementCountIn}`);

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 2: STRUCTURE RESOLVE (formerly builting-structure)
  // ════════════════════════════════════════════════════════════════════════

  // Step 1: Validate CSS
  let validationResult;
  timedStep('validate', () => { validationResult = validateCSS(css); });
  console.log(`Validation: valid=${validationResult.valid}, errors=${validationResult.errors.length}, warnings=${validationResult.warnings.length}`);

  // Step 2: Repair if needed
  if (!validationResult.valid && validationResult.repairable) {
    timedStep('repair', () => repairCSS(css));
    console.log(`Repair complete: ${css.metadata.repairLog?.length || 0} repairs applied`);
  }

  // Step 3: Normalize geometry (origin shift, coordinate clamping)
  timedStep('normalizeGeometry', () => normalizeGeometry(css));

  // Step 3B: Tunnel semantic pipeline (runs when TUNNEL_SEGMENT elements are present)
  // Topology defines structure — generate creates geometry.
  // decomposeTunnelShell now annotates segments with shell metadata (profile, thickness, path)
  // instead of emitting geometry fragments. Shell-fragment steps are disabled.
  if (hasTunnelSegs) {
    console.log('Tunnel segments detected: semantic annotation pipeline (no shell fragment emission)');
    timedStep('decomposeTunnelShell', () => decomposeTunnelShell(css));
    timedStep('generatePortalEndWalls', () => generatePortalEndWalls(css));
    // mergeShortTunnelSegments operates on segments, not fragments — keep it
    timedStep('mergeShortTunnelSegments', () => mergeShortTunnelSegments(css));
    // After decomposeTunnelShell assigns elem-* keys to TUNNEL_SEGMENT elements,
    // remap any stale VSM branch ID container refs on child elements (FAN, PUMP, etc.)
    // to match the new element_key values. Must run before splitTunnelSubSegments
    // so container refs are clean before Z-based splitting reassigns them.
    timedStep('remapVSMContainerRefs', () => remapVSMContainerRefs(css));
    // Split flat segment into main/upper sub-segments by Z range (before bridges are created)
    timedStep('splitTunnelSubSegments', () => splitTunnelSubSegments(css));
    // Detect disconnected orphan segments
    timedStep('auditOrphansAndBridgeGaps', () => auditOrphansAndBridgeGaps(css));
    // Validation passes
    timedStep('validateTunnelGeometry', () => validateTunnelGeometry(css));
    timedStep('auditGeometryGaps', () => auditGeometryGaps(css));
    timedStep('auditVisualGeometryQuality', () => auditVisualGeometryQuality(css));
  }

  // Step 3C: Snap wall endpoints (tiered: 50mm → 150mm)
  timedStep('snapWallEndpoints', () => snapWallEndpoints(css));

  // Step 3D: Bridge VSM node coordinate gaps (tunnel structures only).
  // Inserts TUNNEL_SEGMENT bridge elements between topologically connected branches
  // whose endpoints are not coincident after snapping (gaps > 50mm, < 100m).
  if (hasTunnelSegs) {
    timedStep('bridgeVSMNodes', () => bridgeVSMNodes(css));
  }

  // Step 3E: Build topology graph — tunnel structures build before wall merge (no walls to merge);
  // building structures build after merge so topology reflects merged wall endpoints.
  if (hasTunnelSegs) {
    timedStep('buildTopologyGraph', () => buildTopologyGraph(css));
  }

  // Step 4: Merge walls
  timedStep('mergeWalls', () => mergeWalls(css));

  // Step 4B: Wall axis cleanup
  timedStep('cleanBuildingWallAxes', () => cleanBuildingWallAxes(css));

  // Step 4C: Rebuild topology after merge (building structures — no TUNNEL_SEGMENT elements)
  if (!hasTunnelSegs) {
    timedStep('buildTopologyGraph', () => buildTopologyGraph(css));
  }

  // Step 5: Infer openings
  timedStep('inferOpenings', () => inferOpenings(css));

  // Step 5B: Create opening relationships (VOIDS)
  timedStep('createOpeningRelationships', () => createOpeningRelationships(css));

  // Step 5C: Opening placement validation
  timedStep('validateOpeningPlacement', () => validateOpeningPlacement(css));

  // Step 6: Infer slabs
  timedStep('inferSlabs', () => inferSlabs(css));

  // Step 6-DEDUP: Roof deduplication
  timedStep('deduplicateRoofs', () => deduplicateRoofs(css));

  // Step 6A: Align slabs to walls
  timedStep('alignSlabsToWalls', () => alignSlabsToWalls(css));

  // Step 6A-2: Derive roof elevation from wall heights (parametric height chain)
  timedStep('deriveRoofElevation', () => deriveRoofElevation(css));

  // Step 6A-3: Snap floor slabs to wall bases (gravity check)
  timedStep('snapSlabsToWallBases', () => snapSlabsToWallBases(css));

  // Step 6B: Building envelope guarantee
  timedStep('guaranteeBuildingEnvelope', () => guaranteeBuildingEnvelope(css));

  // Step 6B-DEDUP: Post-envelope roof deduplication
  timedStep('deduplicateRoofsPostEnvelope', () => deduplicateRoofs(css));

  // Step 6B-CLIP: Re-clip any envelope-generated slabs to wall footprint
  timedStep('alignSlabsToWallsPostEnvelope', () => alignSlabsToWalls(css));

  // Step 6C: Snap wall bases to storey floor (close wall-to-floor gaps)
  timedStep('snapWallsToStoreyFloor', () => snapWallsToStoreyFloor(css));

  // Step 7: Envelope fallback check
  timedStep('checkEnvelopeFallback', () => checkEnvelopeFallback(css));

  // Step 7A-2: Infer spaces from wall footprints (buildings only)
  timedStep('inferSpaces', () => inferSpaces(css));

  // Step 7A-3: Space/room container alignment
  timedStep('validateSpaceContainment', () => validateSpaceContainment(css));

  // Step 7B: Building structural validation
  timedStep('validateBuildingStructure', () => validateBuildingStructure(css));

  // Step 7C: Wall envelope clamping
  timedStep('clampWallsToEnvelope', () => clampWallsToEnvelope(css));

  // Step 7D: Dimension validation (universal)
  timedStep('clampAbsurdDimensions', () => clampAbsurdDimensions(css));

  // Track ambiguous wall profiles
  countAmbiguousProfiles(css);
  const ambiguousProfileCount = getAmbiguousProfileCount();
  if (ambiguousProfileCount > 0) {
    console.log(`TopologyEngine: ${ambiguousProfileCount} wall(s) had ambiguous profiles`);
    if (!css.metadata) css.metadata = {};
    css.metadata.ambiguousWallProfiles = ambiguousProfileCount;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3: GEOMETRY BUILD (formerly builting-geometry)
  // The topology graph is STILL IN MEMORY — no serialization needed.
  // ════════════════════════════════════════════════════════════════════════

  console.log('GeometryBuild phase — topology graph in memory, no S3 round-trip');

  // Step G0.5: Deduplicate overlapping tunnel segments (same entry+exit nodes, same direction)
  if (hasTunnelSegs) {
    timedStep('deduplicateOverlappingSegments', () => {
      const seen = new Map();
      let removed = 0;
      css.elements = css.elements.filter(e => {
        if (e.type !== 'TUNNEL_SEGMENT') return true;
        const en = e.properties?.entry_node || '';
        const ex = e.properties?.exit_node || '';
        if (!en || !ex) return true;
        const pairKey = `${en}→${ex}`;
        if (seen.has(pairKey)) {
          // Keep the one with larger profile area
          const existing = seen.get(pairKey);
          const existingArea = (existing.geometry?.profile?.width || 0) * (existing.geometry?.profile?.height || 0);
          const thisArea = (e.geometry?.profile?.width || 0) * (e.geometry?.profile?.height || 0);
          if (thisArea > existingArea) {
            seen.set(pairKey, e);
            return true; // keep this, will filter existing later
          }
          removed++;
          return false;
        }
        seen.set(pairKey, e);
        return true;
      });
      if (removed > 0) console.log(`deduplicateOverlappingSegments: removed ${removed} duplicate segments`);
    });
  }

  // Step G1: Build path connections (uses topology by reference)
  timedStep('buildPathConnections', () => buildPathConnections(css));

  // Step G2: Equipment mounting
  timedStep('applyEquipmentMounting', () => applyEquipmentMounting(css));

  // Step G2.5: Classify geometry behavior (universal geometry contract)
  timedStep('classifyGeometryBehavior', () => classifyGeometryBehavior(css));

  // Step G2.6: Path-author PATH_SWEEP elements (ensure pathPoints, _runAxis, _pathLength)
  timedStep('annotateSweepGeometry', () => annotateSweepGeometry(css));

  // Step G2.6B: Ramp orientation fix (tunnel structures only).
  // For TUNNEL_SEGMENTs where |path ΔZ| > 0.5m, override the flat horizontal
  // axis with the true 3D slope vector so generate extrudes along the incline.
  if (hasTunnelSegs) {
    timedStep('fixRampOrientation', () => fixRampOrientation(css));
  }

  // Step G2.7: Guard invalid sweeps — use _geoBehavior for smarter decisions.
  // PATH_SWEEP elements missing pathPoints → flag for path generation (all domains).
  // Non-PATH_SWEEP elements with SWEEP method + no pathPoints → downgrade to EXTRUSION.
  timedStep('guardInvalidSweeps', () => {
    let downgraded = 0;
    let flaggedLinear = 0;

    for (const elem of css.elements) {
      const geom = elem.geometry;
      if (!geom || geom.method !== 'SWEEP') continue;
      if (Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) continue;

      const behavior = geom._geoBehavior || '';

      geom._failedSweep = true;
      geom._previousMethod = geom.method;

      if (behavior === 'PATH_SWEEP') {
        // PATH_SWEEP without pathPoints: flag for path generation (universal, all domains)
        geom._needsGeneratedPath = true;
        if (!elem.metadata) elem.metadata = {};
        elem.metadata.sweepPathMissing = true;
        flaggedLinear++;
        continue;
      }

      // Non-PATH_SWEEP with SWEEP method + no pathPoints: downgrade to EXTRUSION
      geom.method = 'EXTRUSION';
      delete geom.pathPoints;
      if (geom.profile?.type === 'CIRCLE' && geom.profile.radius) {
        const d = geom.profile.radius * 2;
        geom.profile = { type: 'RECTANGLE', width: d, height: d };
      }
      if (!elem.metadata) elem.metadata = {};
      elem.metadata.sweepDowngraded = true;
      downgraded++;
    }
    console.log(`guardInvalidSweeps: ${downgraded} downgraded, ${flaggedLinear} PATH_SWEEP flagged for path generation`);
  });

  // Step G2.8: Rule assertion pass — physical correctness gates
  // Runs after wall snapping (Phase 2) and MEP path routing (G1). Removes zero-height
  // and floating elements, warns on wall connection gaps and MEP zone containment.
  // Aborts pipeline with a structured error if > 20% of elements are removed.
  let topologyReport = null;
  timedStep('ruleAssertions', () => { topologyReport = runRuleAssertions(css, elementCountIn); });

  // Step G3: CSS validation
  let cssIssues;
  timedStep('validateCSSElements', () => { cssIssues = validateCSSElements(css); });

  // Step G4: Safety checks
  let safetyResult;
  timedStep('safetyChecks', () => {
    safetyResult = runSafetyChecks(css, cssIssues);
  });

  if (!css.metadata) css.metadata = {};
  css.metadata.cssValidationIssues = safetyResult.cssIssues.length;
  css.metadata.cssValidationDetails = safetyResult.cssIssues.length > 0 ? safetyResult.cssIssues.slice(0, 10) : undefined;
  css.metadata.safetyWarnings = safetyResult.safetyWarnings;
  css.metadata.modelExtent = safetyResult.modelExtent;

  // Step G5: Topology validation (uses topology by reference)
  timedStep('validateTopology', () => validateTopology(css));

  // ════════════════════════════════════════════════════════════════════════
  // PRE-GENERATE EXPORT VALIDATION — universal fail-fast gates
  // Strips elements that would produce broken IFC geometry. Applies to
  // all domains (tunnel, building, facility).
  // ════════════════════════════════════════════════════════════════════════

  timedStep('preGenerateExportValidation', () => {
    const finalKeys = new Set();
    for (const e of css.elements) {
      const k = e.element_key || e.id;
      if (k) finalKeys.add(k);
    }

    let strippedHostRef = 0;
    let strippedLinearPath = 0;
    let strippedDuplicateFloor = 0;
    let strippedBadPlacement = 0;
    const LINEAR_MEP_TYPES = new Set(['IfcPipeSegment', 'IfcDuctSegment', 'IfcCableCarrierSegment']);

    // Track floor slabs per container for duplicate detection
    const floorsByContainer = new Map();

    const keep = [];
    for (const elem of css.elements) {
      const type = (elem.type || '').toUpperCase();
      const st = elem.semanticType || '';
      const props = elem.properties || {};
      const meta = elem.metadata || {};
      const geom = elem.geometry || {};

      // ── Gate A: Host/container/relationship target validity ──
      // Elements with host refs that don't resolve → strip
      if (type === 'DOOR' || type === 'WINDOW') {
        const hostKey = meta.hostWallKey;
        if (hostKey && !finalKeys.has(hostKey)) {
          // Try canonical lineage fallback
          const fallback = css.elements.find(e =>
            (e.properties?.derivedFromBranch === hostKey || e.properties?.hostBranch === hostKey) &&
            ((e.type || '').toUpperCase() === 'WALL' || (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT')
          );
          if (fallback) {
            meta.hostWallKey = fallback.element_key || fallback.id;
            meta.hostWallResolved = 'pre_generate_lineage_fallback';
          } else {
            strippedHostRef++;
            continue;
          }
        }
      }

      // Relationship targets must resolve
      if (elem.relationships && Array.isArray(elem.relationships)) {
        const validRels = elem.relationships.filter(r => !r.target || finalKeys.has(r.target));
        if (validRels.length < elem.relationships.length) {
          elem.relationships = validRels;
        }
      }

      // ── Gate B: Linear path validity ──
      // Linear MEP with SWEEP but no pathPoints → flag as invalid, don't generate geometry
      // but keep the element so generator can decide (proxy or skip)
      if (LINEAR_MEP_TYPES.has(st)) {
        const method = geom.method || 'EXTRUSION';
        if (method === 'SWEEP') {
          const pp = geom.pathPoints;
          if (!Array.isArray(pp) || pp.length < 2) {
            if (!elem.metadata) elem.metadata = {};
            elem.metadata._invalidReason = 'sweep_missing_pathPoints';
            elem.metadata._geometryExportable = false;
            strippedLinearPath++; // count but don't strip
          }
        }
        if (method === 'EXTRUSION') {
          const depth = geom.depth || 0;
          if (depth <= 0) {
            if (!elem.metadata) elem.metadata = {};
            elem.metadata._invalidReason = 'zero_depth_extrusion';
            elem.metadata._geometryExportable = false;
            strippedLinearPath++;
          }
        }
      }

      // ── Gate C: Structural placement validity ──
      if (['WALL', 'SLAB', 'TUNNEL_SEGMENT', 'COLUMN', 'BEAM'].includes(type)) {
        const o = elem.placement?.origin;
        if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) {
          strippedBadPlacement++;
          continue;
        }
        const depth = geom.depth || 0;
        const w = geom.profile?.width || geom.profile?.radius || 0;
        if (depth <= 0 || w <= 0) {
          strippedBadPlacement++;
          continue;
        }
      }

      // ── Gate D: Duplicate coplanar floor detection ──
      if (type === 'SLAB' && (props.slabType === 'FLOOR' || !props.slabType)) {
        const container = elem.container || '_default';
        const z = Math.round((elem.placement?.origin?.z || 0) * 10) / 10; // 100mm band
        const floorKey = `${container}:${z}`;
        if (floorsByContainer.has(floorKey)) {
          strippedDuplicateFloor++;
          continue;
        }
        floorsByContainer.set(floorKey, elem.element_key || elem.id);
      }

      // ── Gate E: MEP/Equipment host validation (annotation-only) ──
      // Annotates elements with host validation status for generate lambda.
      // Does NOT strip — generate decides per output mode (HARD=suppress, SOFT=proxy).
      const geoBehavior = geom._geoBehavior || '';
      if (hasTunnelSegs && (geoBehavior === 'PATH_SWEEP' || type === 'EQUIPMENT')) {
        if (!geom._isTunnelShell) { // skip tunnel shell segments (they ARE hosts)
          const hostKey = meta.parentSegment || meta.hostSegmentId ||
                          props.hostStructuralBranchMatched || props.derivedFromBranch ||
                          props.hostBranch || '';
          const hasValidHost = hostKey && finalKeys.has(hostKey);

          if (!elem.metadata) elem.metadata = {};
          if (hasValidHost) {
            elem.metadata._hostValidation = 'VALID';
          } else {
            // Check distance to nearest valid host for WEAK_HOST classification
            const o = elem.placement?.origin;
            let nearestDist = Infinity;
            if (o) {
              for (const candidate of css.elements) {
                if (!candidate.geometry?._isTunnelShell) continue;
                const co = candidate.placement?.origin;
                if (!co) continue;
                // Constrained matching: same container check
                if (elem.container && candidate.container && elem.container !== candidate.container) continue;
                const dist = Math.sqrt(
                  ((o.x || 0) - (co.x || 0)) ** 2 +
                  ((o.y || 0) - (co.y || 0)) ** 2 +
                  ((o.z || 0) - (co.z || 0)) ** 2
                );
                if (dist < nearestDist) nearestDist = dist;
              }
            }
            // Host distance threshold: min(0.5m, 25% of profile max dimension)
            const profMaxDim = Math.max(
              geom.profile?.width || 0, geom.profile?.height || 0,
              (geom.profile?.radius || 0) * 2, 0.5
            );
            const threshold = Math.min(0.5, profMaxDim * 0.25);
            if (nearestDist <= threshold * 10) { // within 10x threshold = weak but usable
              elem.metadata._hostValidation = 'WEAK_HOST';
            } else {
              elem.metadata._hostValidation = 'NO_HOST';
            }
          }

          // Set severity based on output mode
          const outputMode = (css.metadata?.outputMode || 'HYBRID').toUpperCase();
          elem.metadata._hostFailureSeverity =
            (outputMode === 'FULL_AUTHORING' || outputMode === 'COORDINATION') ? 'HARD' : 'SOFT';
        }
      }

      keep.push(elem);
    }

    css.elements = keep;

    const totalStripped = strippedHostRef + strippedLinearPath + strippedDuplicateFloor + strippedBadPlacement;
    if (totalStripped > 0) {
      console.log(`preGenerateExportValidation: stripped ${totalStripped} elements (hostRef=${strippedHostRef}, linearPath=${strippedLinearPath}, duplicateFloor=${strippedDuplicateFloor}, badPlacement=${strippedBadPlacement})`);
    } else {
      console.log('preGenerateExportValidation: all elements passed');
    }

    if (!css.metadata) css.metadata = {};
    css.metadata.preGenerateValidation = {
      strippedHostRef, strippedLinearPath, strippedDuplicateFloor, strippedBadPlacement, totalStripped
    };
  });

  // ════════════════════════════════════════════════════════════════════════
  // UNIVERSAL METADATA — Z convention, export profile
  // ════════════════════════════════════════════════════════════════════════

  if (!css.metadata) css.metadata = {};

  // Step 4: Z convention dual tracking — store both source and normalized conventions
  // so generate lambda can skip its heuristic, and logs can reference source for debugging.
  css.metadata.zConvention = {
    source: hasTunnelSegs ? 'MINE_ABSOLUTE' : 'MIXED',
    normalized: 'STOREY_RELATIVE',
    origin: 'topology_engine'
  };

  // Step 5: Export profile — informs generator's IFC representation choices.
  // Default to WEB_VIEWER; can be overridden by upstream metadata.
  css.metadata.exportProfile = css.metadata.exportProfile || 'WEB_VIEWER';

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 4: V2 ADAPTER BOUNDARY
  // Build resolved.json from the in-memory CSS (topology included).
  // ════════════════════════════════════════════════════════════════════════

  console.log('Adapter phase — building v2 artifacts from in-memory graph');

  // Inferred.json (v2 dual-write)
  const inferred = cssToInferred(css);

  // Resolved.json (canonical v2 artifact)
  const resolved = cssToResolved(css);

  // Legacy CSS (for Generate)
  const legacyCss = resolvedToLegacyCss(resolved);

  // Relationship property integrity check
  const anglesBefore = css.elements
    .flatMap(e => e.relationships || [])
    .filter(r => r.connectionAngle !== null && r.connectionAngle !== undefined).length;
  const anglesAfter = legacyCss.elements
    .flatMap(e => e.relationships || [])
    .filter(r => r.connectionAngle !== null && r.connectionAngle !== undefined).length;
  if (anglesBefore !== anglesAfter) {
    console.warn(`RELATIONSHIP_PROP_LOSS: anglesBefore=${anglesBefore} anglesAfter=${anglesAfter} lost=${anglesBefore - anglesAfter}`);
  }

  // Round-trip fidelity check
  const mismatches = [];
  for (let i = 0; i < css.elements.length; i++) {
    const orig = css.elements[i];
    const rt = legacyCss.elements[i];
    if (!rt) { mismatches.push({ index: i, id: orig.id, issue: 'missing in round-trip' }); continue; }
    if (orig.id !== rt.id) mismatches.push({ id: orig.id, field: 'id', expected: orig.id, got: rt.id });
    if (orig.type !== rt.type) mismatches.push({ id: orig.id, field: 'type', expected: orig.type, got: rt.type });
    if (orig.confidence !== rt.confidence) mismatches.push({ id: orig.id, field: 'confidence', expected: orig.confidence, got: rt.confidence });
    if (orig.geometry?.method !== rt.geometry?.method) mismatches.push({ id: orig.id, field: 'geometry.method', expected: orig.geometry?.method, got: rt.geometry?.method });
    if (orig.geometry?.depth !== rt.geometry?.depth) mismatches.push({ id: orig.id, field: 'geometry.depth', expected: orig.geometry?.depth, got: rt.geometry?.depth });
    if (JSON.stringify(orig.placement?.origin) !== JSON.stringify(rt.placement?.origin)) mismatches.push({ id: orig.id, field: 'placement.origin' });
    if (orig.container !== rt.container) mismatches.push({ id: orig.id, field: 'container', expected: orig.container, got: rt.container });
  }
  if (legacyCss.elements.length !== css.elements.length) {
    mismatches.push({ issue: 'element_count_mismatch', expected: css.elements.length, got: legacyCss.elements.length });
  }
  if (mismatches.length > 0) {
    console.warn(`Round-trip fidelity: ${mismatches.length} mismatches found`);
    console.warn(`Mismatches (first 10): ${JSON.stringify(mismatches.slice(0, 10))}`);
  } else {
    console.log('Round-trip fidelity: PASS — 0 mismatches');
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 5: MODEL VALIDATION (formerly builting-validate)
  // Runs in the same memory context — no S3 read needed.
  // ════════════════════════════════════════════════════════════════════════

  console.log('Validation phase — running all 4 validators in-memory');

  const { report: validationReport, readiness, semantic: semResult, geometric: geomResult } = runFullValidation(resolved);

  // Compute readiness delta if previous report exists
  let readinessDelta = null;
  if (revision > 1 && previousValidationReportS3Key) {
    try {
      const prevResponse = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: previousValidationReportS3Key
      }));
      const prevReport = JSON.parse(await prevResponse.Body.transformToString());
      const prevScore = prevReport.readiness?.score ?? null;
      const prevIssueCount = prevReport.summary?.totalIssues ?? null;
      const prevAuthoringSuitability = prevReport.readiness?.authoringSuitability ?? null;

      if (prevScore !== null) {
        readinessDelta = {
          previousScore: prevScore,
          currentScore: readiness.score,
          delta: readiness.score - prevScore,
          previousIssueCount: prevIssueCount,
          currentIssueCount: validationReport.summary.totalIssues,
          issueDelta: prevIssueCount !== null ? validationReport.summary.totalIssues - prevIssueCount : null,
          previousAuthoringSuitability: prevAuthoringSuitability,
          currentAuthoringSuitability: readiness.authoringSuitability,
          improved: readiness.score > prevScore
        };
        console.log(`Readiness delta: ${prevScore} → ${readiness.score} (${readinessDelta.delta >= 0 ? '+' : ''}${readinessDelta.delta})`);
      }
    } catch (deltaErr) {
      console.warn('Could not compute readiness delta (non-fatal):', deltaErr.message);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 6: WRITE ALL ARTIFACTS TO S3
  // ════════════════════════════════════════════════════════════════════════

  const totalDurationMs = Date.now() - startTime;
  const finalTrace = buildTypeHistogram(css.elements);

  console.log(`TopologyEngine pipeline complete in ${totalDurationMs}ms — writing artifacts to S3`);
  console.log(`Final type histogram: ${JSON.stringify(finalTrace)}`);

  // 1. css_structure.json (intermediate, for debugging)
  const structureKey = `uploads/${userId}/${renderId}/css/css_structure.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: structureKey,
    Body: JSON.stringify(css), ContentType: 'application/json'
  }));

  // 2. css_processed.json (for Generate)
  const processedKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: processedKey,
    Body: JSON.stringify(legacyCss), ContentType: 'application/json'
  }));

  // 3. inferred.json (v2)
  const inferredKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/inferred.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: inferredKey,
    Body: JSON.stringify(inferred), ContentType: 'application/json'
  }));

  // 4. resolved.json (v2 canonical)
  const resolvedKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/resolved.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: resolvedKey,
    Body: JSON.stringify(resolved), ContentType: 'application/json'
  }));

  // 5. validation_report.json
  const validationReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/validation_report.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: validationReportKey,
    Body: JSON.stringify(validationReport), ContentType: 'application/json'
  }));

  // 6. Topology engine report (unified debug artifact)
  const engineReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/topology_engine_report.json`;
  const engineReport = {
    pipelineVersion: '3.0',
    stage: 'topology_engine',
    generatedAt: new Date().toISOString(),
    durationMs: totalDurationMs,
    domain: css.domain || 'UNKNOWN',
    elementCountIn,
    elementCountOut: css.elements.length,
    finalTypeHistogram: finalTrace,
    stepTimings,
    ambiguousWallProfiles: ambiguousProfileCount,
    cssValidation: {
      valid: validationResult.valid,
      errorCount: validationResult.errors.length,
      warningCount: validationResult.warnings.length
    },
    cssValidationIssueCount: safetyResult.cssIssues.length,
    safetyWarningCount: safetyResult.safetyWarnings.length,
    modelValidation: {
      readinessScore: readiness.score,
      exportReadiness: readiness.exportReadiness,
      authoringSuitability: readiness.authoringSuitability,
      generationMode: readiness.generationModeRecommendation,
      errorCount: validationReport.summary.errorCount,
      warningCount: validationReport.summary.warningCount,
      proxyRatio: semResult.summary.proxyRatio,
      geometryFidelity: geomResult.summary.geometryFidelity || null,
    },
    roundTripFidelity: {
      mismatches: mismatches.length,
      pass: mismatches.length === 0
    }
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: engineReportKey,
    Body: JSON.stringify(engineReport), ContentType: 'application/json'
  }));

  // 7. Issue report (combined — compatible with existing expectations)
  const issueReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/issue_report.json`;
  const issueReport = {
    pipelineVersion: '3.0',
    stage: 'topology_engine',
    generatedAt: new Date().toISOString(),
    validation: {
      valid: validationResult.valid,
      errorCount: validationResult.errors.length,
      warningCount: validationResult.warnings.length
    },
    cssValidationIssues: safetyResult.cssIssues.slice(0, 20),
    safetyWarnings: safetyResult.safetyWarnings,
    repairCount: css.metadata?.repairLog?.length || 0
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: issueReportKey,
    Body: JSON.stringify(issueReport), ContentType: 'application/json'
  }));

  // 8. Transform debug (compatible with existing expectations)
  const debugKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/transform_debug.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: debugKey,
    Body: JSON.stringify({
      pipelineVersion: '3.0',
      stage: 'topology_engine',
      generatedAt: new Date().toISOString(),
      durationMs: totalDurationMs,
      domain: css.domain || 'UNKNOWN',
      elementCountOut: css.elements.length,
      stepTimings,
      cssSnapshotKey: processedKey
    }),
    ContentType: 'application/json'
  }));

  console.log(`TopologyEngine complete: ${totalDurationMs}ms, ${css.elements.length} elements, score=${readiness.score}, export=${readiness.exportReadiness}`);

  // ════════════════════════════════════════════════════════════════════════
  // RETURN — combined output for Step Function
  // ════════════════════════════════════════════════════════════════════════

  return {
    // Geometry output (for Generate)
    cssS3Key: processedKey,
    resolvedS3Key: resolvedKey,

    // Validation output (for Store)
    validationReportS3Key: validationReportKey,
    readinessScore: readiness.score,
    exportReadiness: readiness.exportReadiness,
    authoringSuitability: readiness.authoringSuitability,
    criticalIssueCount: validationReport.summary.errorCount,
    warningCount: validationReport.summary.warningCount,
    proxyRatio: semResult.summary.proxyRatio,
    generationModeRecommendation: readiness.generationModeRecommendation,
    readinessDelta,
    geometryFidelity: geomResult.summary.geometryFidelity || null,

    // Structure output (for observability)
    inferredS3Key: inferredKey,
    elementCount: css.elements.length,
    domain: css.domain || 'UNKNOWN',
    validationResult: {
      valid: validationResult.valid,
      errorCount: validationResult.errors.length,
      warningCount: validationResult.warnings.length,
      errors: validationResult.errors.slice(0, 20),
      warnings: validationResult.warnings.slice(0, 20)
    },

    // Rule assertion findings (new top-level key — no existing schema changes)
    topology_report: topologyReport
  };
};
