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
 *   SnapWallEndpoints (tiered: 50mm → 150mm) →
 *   [BUILDING] MergeWalls → CleanWallAxes → BuildTopology →
 *   InferOpenings → CreateOpeningRelationships → InferSlabs →
 *   DeriveRoofElevation → AlignSlabsToWalls → GuaranteeBuildingEnvelope →
 *   ClampDimensions →
 *   BuildPathConnections → EquipmentMounting → AnnotateSweepGeometry →
 *   CSSValidation → SafetyChecks → ValidateTopology →
 *   RunFullModelValidation →
 *   v2 Adapter (inferred.json + resolved.json + css_processed.json) →
 *   Write all artifacts to S3
 *
 * Input:  { cssS3Key, userId, renderId, bucket, renderRevision, previousValidationReportS3Key }
 * Output: { cssS3Key, resolvedS3Key, validationReportS3Key, readinessScore, ... }
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

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
  deduplicateRoofs, deriveRoofElevation, snapSlabsToWallBases,
  mergeShortTunnelSegments, validateSpaceContainment, inferSpaces
} from './building-envelope.mjs';

// ── Geometry modules ──
import { buildPathConnections } from './path-connections.mjs';
import { applyEquipmentMounting } from './equipment.mjs';
import { validateCSSElements, runSafetyChecks } from './safety.mjs';
import { validateTopology } from './topology-validate.mjs';

// ── Validation modules ──
import { runFullValidation } from './model-validate.mjs';

// ── v2 Adapters ──
import { cssToInferred, cssToResolved, resolvedToLegacyCss } from './v2-adapter.mjs';

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

/**
 * Annotate DUCT and PIPE elements with SWEEP geometry method for circular profiles.
 */
function annotateSweepGeometry(css) {
  if (!css.elements) return;

  const SWEEP_TYPES = new Set(['DUCT', 'PIPE']);
  let annotated = 0;

  for (const elem of css.elements) {
    if (!SWEEP_TYPES.has(elem.type)) continue;
    const geom = elem.geometry;
    if (!geom) continue;
    const profile = geom.profile || {};
    if (profile.type !== 'CIRCLE' && !profile.radius) continue;
    if (geom.method === 'SWEEP') continue;

    const placement = elem.placement || {};
    const origin = placement.origin || { x: 0, y: 0, z: 0 };
    const axis = placement.axis || geom.direction || { x: 0, y: 0, z: 1 };
    const depth = geom.depth || 1.0;
    if (depth <= 0) continue;

    const ax = axis.x || 0, ay = axis.y || 0, az = axis.z || 0;
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-10) continue;
    const nx = ax / len, ny = ay / len, nz = az / len;

    geom.method = 'SWEEP';
    geom.pathPoints = [
      { x: origin.x - nx * depth / 2, y: origin.y - ny * depth / 2, z: origin.z - nz * depth / 2 },
      { x: origin.x + nx * depth / 2, y: origin.y + ny * depth / 2, z: origin.z + nz * depth / 2 }
    ];
    geom._previousMethod = 'EXTRUSION';
    annotated++;
  }

  if (annotated > 0) {
    console.log(`annotateSweepGeometry: ${annotated} DUCT/PIPE elements annotated with SWEEP method`);
  }
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

  const elementCountIn = css.elements.length;
  const domain = (css.domain || '').toUpperCase();

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

  // Step 3B: Tunnel semantic pipeline (TUNNEL domain only)
  // Topology defines structure — generate creates geometry.
  // decomposeTunnelShell now annotates segments with shell metadata (profile, thickness, path)
  // instead of emitting geometry fragments. Shell-fragment steps are disabled.
  if (domain === 'TUNNEL') {
    console.log('TUNNEL domain: semantic annotation pipeline (no shell fragment emission)');
    timedStep('decomposeTunnelShell', () => decomposeTunnelShell(css));
    timedStep('generatePortalEndWalls', () => generatePortalEndWalls(css));
    // mergeShortTunnelSegments operates on segments, not fragments — keep it
    timedStep('mergeShortTunnelSegments', () => mergeShortTunnelSegments(css));
    // Detect disconnected orphan segments
    timedStep('auditOrphansAndBridgeGaps', () => auditOrphansAndBridgeGaps(css));
    // Validation passes
    timedStep('validateTunnelGeometry', () => validateTunnelGeometry(css));
    timedStep('auditGeometryGaps', () => auditGeometryGaps(css));
    timedStep('auditVisualGeometryQuality', () => auditVisualGeometryQuality(css));
  }

  // Step 3C: Snap wall endpoints (tiered: 50mm → 150mm)
  timedStep('snapWallEndpoints', () => snapWallEndpoints(css));

  // Step 3E: Build topology graph (TUNNEL builds before merge, BUILDING after)
  if (domain === 'TUNNEL') {
    timedStep('buildTopologyGraph', () => buildTopologyGraph(css));
  }

  // Step 4: Merge walls
  timedStep('mergeWalls', () => mergeWalls(css));

  // Step 4B: Wall axis cleanup
  timedStep('cleanBuildingWallAxes', () => cleanBuildingWallAxes(css));

  // Step 4C: Rebuild topology after merge (BUILDING)
  if (domain !== 'TUNNEL') {
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
  if (domain === 'TUNNEL') {
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

  // Step G2.5: Annotate sweep geometry for ducts/pipes
  timedStep('annotateSweepGeometry', () => annotateSweepGeometry(css));

  // Step G2.6: Guard invalid sweeps — downgrade non-MEP SWEEP to EXTRUSION,
  // but FLAG tunnel linear MEP (pipes/ducts/trays) as needing path generation
  // instead of converting them to vertical extrusions.
  timedStep('guardInvalidSweeps', () => {
    let downgraded = 0;
    let flaggedLinear = 0;
    const isTunnel = (css.domain || '').toUpperCase() === 'TUNNEL';

    for (const elem of css.elements) {
      const geom = elem.geometry;
      if (!geom || geom.method !== 'SWEEP') continue;
      if (Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) continue;

      const st = elem.semanticType || '';
      const isLinearMEP = ['IfcPipeSegment', 'IfcDuctSegment', 'IfcCableCarrierSegment'].includes(st);

      geom._failedSweep = true;
      geom._previousMethod = geom.method;

      if (isTunnel && isLinearMEP) {
        // Don't downgrade — flag for path generation by centerline inheritance
        geom._needsGeneratedPath = true;
        if (!elem.metadata) elem.metadata = {};
        elem.metadata.sweepPathMissing = true;
        flaggedLinear++;
        continue;
      }

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
    console.log(`guardInvalidSweeps: ${downgraded} downgraded, ${flaggedLinear} tunnel linear MEP flagged for path generation`);
  });

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
      warningCount: validationReport.summary.warningCount
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
    }
  };
};
