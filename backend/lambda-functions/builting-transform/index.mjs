/**
 * CSS Pipeline Lambda (consolidated)
 *
 * Runs: ValidateCSS → RepairCSS (if needed) → NormalizeGeometry → MergeWalls → InferOpenings → InferSlabs
 * All in one Lambda call to reduce cold starts and simplify the Step Function.
 *
 * Input: { cssS3Key, userId, renderId, bucket }
 * Output: { cssS3Key (processed CSS saved back to S3) }
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';

const s3 = new S3Client({});

export const handler = async (event) => {
  console.log('CSS Pipeline invoked');

  const { cssS3Key, userId, renderId, bucket } = event;

  // Load CSS from S3
  let css;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cssS3Key }));
    css = JSON.parse(await response.Body.transformToString());
    console.log(`Loaded CSS from S3: ${cssS3Key} (${css.elements?.length || 0} elements)`);
  } catch (err) {
    console.error('Failed to load CSS from S3:', err.message);
    throw new Error(`Failed to load CSS from S3: ${err.message}`);
  }

  if (!css || !css.elements) {
    console.log('No CSS or elements');
    throw new Error('CSS loaded from S3 has no elements');
  }

  // ========== STEP 1: VALIDATE ==========
  const validationResult = validateCSS(css);
  console.log(`Validation: valid=${validationResult.valid}, errors=${validationResult.errors.length}, warnings=${validationResult.warnings.length}`);

  // ========== STEP 2: REPAIR (if needed) ==========
  if (!validationResult.valid && validationResult.repairable) {
    repairCSS(css);
    console.log(`Repair complete: ${css.metadata.repairLog?.length || 0} repairs applied`);
  }

  // ========== STEP 3: NORMALIZE GEOMETRY ==========
  normalizeGeometry(css);
  console.log('Geometry normalization complete');

  // ========== STEP 3B: TUNNEL SHELL DECOMPOSITION ==========
  decomposeTunnelShell(css);

  // ========== STEP 4: MERGE WALLS ==========
  mergeWalls(css);
  console.log('Wall merge complete');

  // ========== STEP 5: INFER OPENINGS ==========
  inferOpenings(css);
  console.log('Opening inference complete');

  // ========== STEP 5B: CREATE OPENING RELATIONSHIPS (VOIDS) ==========
  createOpeningRelationships(css);
  console.log('Opening relationships complete');

  // ========== STEP 6: INFER SLABS ==========
  inferSlabs(css);
  console.log('Slab inference complete');

  // ========== STEP 7: ENVELOPE FALLBACK CHECK (v3.2) ==========
  checkEnvelopeFallback(css);

  // ========== STEP 7B: BUILDING STRUCTURAL VALIDATION (v6) ==========
  validateBuildingStructure(css);

  // ========== STEP 8: CSS VALIDATION (v6) ==========
  const cssIssues = [];
  const elementKeys = new Set();
  for (const e of css.elements) {
    if (e.element_key && elementKeys.has(e.element_key))
      cssIssues.push(`Duplicate element_key: ${e.element_key}`);
    if (e.element_key) elementKeys.add(e.element_key);
    const o = e.placement?.origin;
    if (o && (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)))
      cssIssues.push(`NaN/Inf placement: ${e.id}`);
    const g = e.geometry;
    if (g?.depth !== undefined && (!Number.isFinite(g.depth) || g.depth <= 0))
      cssIssues.push(`Invalid depth: ${e.id}`);
  }
  if (cssIssues.length > 0) {
    console.warn(`v6 CSS validation: ${cssIssues.length} issues: ${cssIssues.slice(0, 5).join('; ')}`);
  }
  // ========== STEP 9: SAFETY CHECKS (v6+ Phase 8) ==========
  const safetyWarnings = [];

  // 9A: Element count limits — prevent runaway generation
  const MAX_ELEMENTS = 5000;
  if (css.elements.length > MAX_ELEMENTS) {
    safetyWarnings.push(`CRITICAL: Element count ${css.elements.length} exceeds limit ${MAX_ELEMENTS} — truncating`);
    console.warn(`Safety: truncating ${css.elements.length} elements to ${MAX_ELEMENTS}`);
    css.elements = css.elements.slice(0, MAX_ELEMENTS);
  }

  // 9B: Geometry bounds — detect elements at unreasonable coordinates
  const MAX_COORD = 100000; // 100km max extent
  const MAX_DIMENSION = 10000; // 10km max single dimension
  let outOfBoundsCount = 0;
  for (const e of css.elements) {
    const o = e.placement?.origin;
    if (o) {
      if (Math.abs(o.x) > MAX_COORD || Math.abs(o.y) > MAX_COORD || Math.abs(o.z) > MAX_COORD) {
        outOfBoundsCount++;
        if (outOfBoundsCount <= 3) cssIssues.push(`Out-of-bounds placement: ${e.id} at (${o.x},${o.y},${o.z})`);
      }
    }
    const g = e.geometry;
    if (g) {
      const w = g.profile?.width || 0;
      const h = g.profile?.height || 0;
      const d = g.depth || 0;
      if (w > MAX_DIMENSION || h > MAX_DIMENSION || d > MAX_DIMENSION) {
        cssIssues.push(`Oversized geometry: ${e.id} (${w}x${h}x${d})`);
      }
    }
  }
  if (outOfBoundsCount > 0) safetyWarnings.push(`${outOfBoundsCount} elements at coordinates beyond ±${MAX_COORD}m`);

  // 9C: Overlap detection — check for elements at identical positions (potential duplicates)
  const positionMap = new Map();
  let duplicatePositionCount = 0;
  for (const e of css.elements) {
    const o = e.placement?.origin;
    if (!o) continue;
    const posKey = `${Math.round(o.x*10)},${Math.round(o.y*10)},${Math.round(o.z*10)},${e.type}`;
    if (positionMap.has(posKey)) {
      duplicatePositionCount++;
      if (duplicatePositionCount <= 3) {
        const existing = positionMap.get(posKey);
        cssIssues.push(`Potential overlap: ${e.id} (${e.name}) at same position as ${existing.id} (${existing.name})`);
      }
    } else {
      positionMap.set(posKey, e);
    }
  }
  if (duplicatePositionCount > 0) safetyWarnings.push(`${duplicatePositionCount} potential element overlaps detected`);

  // 9D: Coordinate sanity — all elements should be in a reasonable bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const e of css.elements) {
    const o = e.placement?.origin;
    if (!o || !Number.isFinite(o.x)) continue;
    minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
    minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
    minZ = Math.min(minZ, o.z); maxZ = Math.max(maxZ, o.z);
  }
  const modelExtentX = maxX - minX;
  const modelExtentY = maxY - minY;
  const modelExtentZ = maxZ - minZ;
  if (Number.isFinite(modelExtentX) && (modelExtentX > 10000 || modelExtentY > 10000 || modelExtentZ > 5000)) {
    safetyWarnings.push(`Large model extent: ${modelExtentX.toFixed(0)}m x ${modelExtentY.toFixed(0)}m x ${modelExtentZ.toFixed(0)}m — check for outliers`);
  }

  if (safetyWarnings.length > 0) {
    console.warn(`v6+ Safety checks: ${safetyWarnings.length} warnings`);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.cssValidationIssues = cssIssues.length;
  css.metadata.cssValidationDetails = cssIssues.length > 0 ? cssIssues.slice(0, 10) : undefined;
  css.metadata.safetyWarnings = safetyWarnings;
  css.metadata.modelExtent = Number.isFinite(modelExtentX) ? {
    x: Math.round(modelExtentX * 100) / 100,
    y: Math.round(modelExtentY * 100) / 100,
    z: Math.round(modelExtentZ * 100) / 100,
    elementCount: css.elements.length,
    duplicatePositions: duplicatePositionCount,
    outOfBounds: outOfBoundsCount
  } : null;

  // Save processed CSS back to S3
  const processedKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: processedKey,
    Body: JSON.stringify(css),
    ContentType: 'application/json'
  }));
  console.log(`Processed CSS saved to S3: ${processedKey}`);

  return { cssS3Key: processedKey };
};


// ============================================================================
// VALIDATE CSS
// ============================================================================

function validateCSS(css) {
  const errors = [];
  const warnings = [];
  const repairSuggestions = [];

  if (css.cssVersion !== '1.0') {
    errors.push({ field: 'cssVersion', message: `Expected "1.0", got "${css.cssVersion}"`, severity: 'error' });
  }

  if (!css.elements || !Array.isArray(css.elements) || css.elements.length === 0) {
    return { valid: false, repairable: false, errors: [{ field: 'elements', message: 'Missing or empty elements', severity: 'error' }], warnings: [], repairSuggestions: [] };
  }

  if (!css.levelsOrSegments || css.levelsOrSegments.length === 0) {
    errors.push({ field: 'levelsOrSegments', message: 'Missing levelsOrSegments', severity: 'error' });
    repairSuggestions.push({ action: 'add_default_level', field: 'levelsOrSegments' });
  }

  const validContainers = new Set((css.levelsOrSegments || []).map(l => l.id));
  const validElementIds = new Set(css.elements.map(e => e.id));

  for (const elem of css.elements) {
    const eid = elem.id || 'unknown';

    if (!elem.placement || !elem.placement.origin) {
      errors.push({ elementId: eid, field: 'placement', message: 'Missing placement', severity: 'error' });
      repairSuggestions.push({ elementId: eid, action: 'assign_default_placement' });
    }

    if (!elem.geometry || !elem.geometry.method) {
      errors.push({ elementId: eid, field: 'geometry', message: 'Missing geometry', severity: 'error' });
      repairSuggestions.push({ elementId: eid, action: 'assign_default_geometry' });
    }

    if (!elem.container || !validContainers.has(elem.container)) {
      errors.push({ elementId: eid, field: 'container', message: `Invalid container: ${elem.container}`, severity: 'error' });
      repairSuggestions.push({ elementId: eid, action: 'assign_first_container' });
    }

    if (elem.geometry) {
      const d = elem.geometry.depth;
      if (d !== undefined && (d <= 0 || !isFinite(d))) {
        errors.push({ elementId: eid, field: 'geometry.depth', message: `Invalid depth: ${d}`, severity: 'error' });
        repairSuggestions.push({ elementId: eid, action: 'clamp_dimension', field: 'geometry.depth' });
      }
    }

    if (elem.placement?.origin) {
      for (const c of ['x', 'y', 'z']) {
        if (!isFinite(elem.placement.origin[c])) {
          errors.push({ elementId: eid, field: `placement.origin.${c}`, message: 'Non-finite value', severity: 'error' });
          repairSuggestions.push({ elementId: eid, action: 'replace_nan', field: `placement.origin.${c}` });
        }
      }
    }

    // Warnings
    if (elem.confidence !== undefined && elem.confidence < 0.3) {
      warnings.push({ elementId: eid, field: 'confidence', message: `Very low: ${elem.confidence}`, severity: 'warning' });
    }

    if (elem.relationships) {
      for (const rel of elem.relationships) {
        if (!validElementIds.has(rel.target)) {
          warnings.push({ elementId: eid, field: 'relationships', message: `Dangling target: ${rel.target}`, severity: 'warning' });
          repairSuggestions.push({ elementId: eid, action: 'remove_dangling_relationship' });
        }
      }
    }
  }

  // Bbox warning
  if (css.metadata?.bbox) {
    const { min, max } = css.metadata.bbox;
    const maxDim = Math.max(
      Math.abs((max?.x || 0) - (min?.x || 0)),
      Math.abs((max?.y || 0) - (min?.y || 0)),
      Math.abs((max?.z || 0) - (min?.z || 0))
    );
    if (maxDim > 10000) {
      warnings.push({ field: 'bbox', message: `Extends beyond 10km: ${maxDim.toFixed(0)}m`, severity: 'warning' });
    }
  }

  const hasErrors = errors.filter(e => e.severity === 'error').length > 0;
  return { valid: !hasErrors, repairable: hasErrors && repairSuggestions.length > 0, errors, warnings, repairSuggestions };
}


// ============================================================================
// REPAIR CSS
// ============================================================================

function repairCSS(css) {
  const repairLog = css.metadata?.repairLog || [];
  const validContainers = new Set((css.levelsOrSegments || []).map(l => l.id));
  const validElementIds = new Set(css.elements.map(e => e.id));

  // Ensure levelsOrSegments
  if (!css.levelsOrSegments || css.levelsOrSegments.length === 0) {
    css.levelsOrSegments = [{ id: 'level-1', type: 'STOREY', name: 'Ground Floor', elevation_m: 0, height_m: 3 }];
    validContainers.add('level-1');
    repairLog.push({ elementId: 'global', action: 'added_default_level', field: 'levelsOrSegments' });
  }

  const firstContainerId = css.levelsOrSegments[0].id;

  for (const elem of css.elements) {
    const eid = elem.id || 'unknown';

    // Fix missing placement
    if (!elem.placement) {
      elem.placement = { origin: { x: 0, y: 0, z: 0 } };
      repairLog.push({ elementId: eid, action: 'assigned_default_placement', field: 'placement' });
    }
    if (!elem.placement.origin) {
      elem.placement.origin = { x: 0, y: 0, z: 0 };
      repairLog.push({ elementId: eid, action: 'assigned_default_origin', field: 'placement.origin' });
    }

    // Fix NaN in placement
    for (const c of ['x', 'y', 'z']) {
      if (!isFinite(elem.placement.origin[c])) {
        elem.placement.origin[c] = 0;
        repairLog.push({ elementId: eid, action: 'replaced_nan', field: `placement.origin.${c}` });
      }
    }

    // Fix missing geometry
    if (!elem.geometry) {
      elem.geometry = { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 1, height: 1 }, direction: { x: 0, y: 0, z: 1 }, depth: 1 };
      repairLog.push({ elementId: eid, action: 'assigned_default_geometry', field: 'geometry' });
    }
    if (!elem.geometry.method) elem.geometry.method = 'EXTRUSION';

    // Fix dimensions
    if (elem.geometry.depth !== undefined) {
      if (!isFinite(elem.geometry.depth) || elem.geometry.depth <= 0) {
        elem.geometry.depth = 1;
        repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'geometry.depth' });
      } else if (elem.geometry.depth > 500) {
        elem.geometry.depth = 500;
        repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'geometry.depth' });
      }
    }

    if (elem.geometry.profile) {
      const p = elem.geometry.profile;
      if (p.width !== undefined && (!isFinite(p.width) || p.width <= 0)) { p.width = 1; repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'profile.width' }); }
      if (p.height !== undefined && (!isFinite(p.height) || p.height <= 0)) { p.height = 1; repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'profile.height' }); }
      if (p.radius !== undefined && (!isFinite(p.radius) || p.radius <= 0)) { p.radius = 0.5; repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'profile.radius' }); }
    }

    // Fix container
    if (!elem.container || !validContainers.has(elem.container)) {
      elem.container = firstContainerId;
      repairLog.push({ elementId: eid, action: 'assigned_container', field: 'container' });
    }

    // Fix confidence/source
    if (elem.confidence === undefined || !isFinite(elem.confidence)) elem.confidence = 0.5;
    elem.confidence = Math.max(0, Math.min(1, elem.confidence));
    if (!elem.source) elem.source = 'LLM';

    // Remove dangling relationships
    if (elem.relationships && Array.isArray(elem.relationships)) {
      elem.relationships = elem.relationships.filter(rel => {
        if (!validElementIds.has(rel.target)) {
          repairLog.push({ elementId: eid, action: 'removed_dangling_relationship', field: 'relationships' });
          return false;
        }
        return true;
      });
    }
  }

  css.metadata = css.metadata || {};
  css.metadata.repairLog = repairLog;
  if (repairLog.length > 0) css.metadata.validationStatus = 'REPAIRED';

  // STRICT FALLBACK: if still broken, downgrade everything to PROXY
  const stillBroken = css.elements.some(e => !e.placement?.origin || !e.geometry?.method || !e.container);
  if (stillBroken) {
    console.log('Still invalid after repair — PROXY_ONLY fallback');
    css.metadata.outputMode = 'PROXY_ONLY';
    for (const elem of css.elements) {
      if (elem.type !== 'PROXY') {
        elem.semanticType = elem.semanticType || elem.type;
        elem.type = 'PROXY';
        repairLog.push({ elementId: elem.id, action: 'downgraded_to_proxy', field: 'type' });
      }
      if (elem.relationships) elem.relationships = elem.relationships.filter(r => r.type === 'CONTAINS');
    }
    const counts = {};
    for (const e of css.elements) counts[e.type] = (counts[e.type] || 0) + 1;
    css.metadata.elementCounts = counts;
  }
}


// ============================================================================
// NORMALIZE GEOMETRY
// ============================================================================

function normalizeGeometry(css) {
  const MAX_COORD = 50000;

  // Compute bbox from placements
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const elem of css.elements) {
    const o = elem.placement?.origin;
    if (!o) continue;
    const x = safe(o.x), y = safe(o.y), z = safe(o.z);
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }

  if (!isFinite(minX)) return; // no valid elements

  const shiftX = -minX, shiftY = -minY, shiftZ = -minZ;

  for (const elem of css.elements) {
    if (elem.placement?.origin) {
      elem.placement.origin.x = clamp(safe(elem.placement.origin.x) + shiftX, MAX_COORD);
      elem.placement.origin.y = clamp(safe(elem.placement.origin.y) + shiftY, MAX_COORD);
      elem.placement.origin.z = clamp(safe(elem.placement.origin.z) + shiftZ, MAX_COORD);
    }
    if (elem.placement?.axis) sanitizeDir(elem.placement.axis);
    if (elem.placement?.refDirection) sanitizeDir(elem.placement.refDirection);

    if (elem.geometry) {
      if (elem.geometry.depth !== undefined) {
        elem.geometry.depth = clamp(Math.abs(safe(elem.geometry.depth)), MAX_COORD);
        if (elem.geometry.depth <= 0) elem.geometry.depth = 0.01;
      }
      if (elem.geometry.direction) sanitizeDir(elem.geometry.direction);
      if (elem.geometry.profile) {
        const p = elem.geometry.profile;
        if (p.width !== undefined) p.width = Math.abs(safe(p.width)) || 1;
        if (p.height !== undefined) p.height = Math.abs(safe(p.height)) || 1;
        if (p.radius !== undefined) p.radius = Math.abs(safe(p.radius)) || 0.5;
      }
      if (elem.geometry.vertices) {
        for (const v of elem.geometry.vertices) {
          v.x = clamp(safe(v.x) + shiftX, MAX_COORD);
          v.y = clamp(safe(v.y) + shiftY, MAX_COORD);
          v.z = clamp(safe(v.z) + shiftZ, MAX_COORD);
        }
      }
    }
  }

  if (css.facility) css.facility.origin = { x: 0, y: 0, z: 0 };

  // Recalculate bbox
  let nMinX = Infinity, nMinY = Infinity, nMinZ = Infinity;
  let nMaxX = -Infinity, nMaxY = -Infinity, nMaxZ = -Infinity;
  for (const elem of css.elements) {
    const o = elem.placement?.origin;
    if (!o) continue;
    nMinX = Math.min(nMinX, o.x); nMinY = Math.min(nMinY, o.y); nMinZ = Math.min(nMinZ, o.z);
    nMaxX = Math.max(nMaxX, o.x); nMaxY = Math.max(nMaxY, o.y); nMaxZ = Math.max(nMaxZ, o.z);
  }
  if (isFinite(nMinX)) {
    css.metadata.bbox = { min: { x: nMinX, y: nMinY, z: nMinZ }, max: { x: nMaxX, y: nMaxY, z: nMaxZ } };
  }
  css.metadata.unitNormalizationApplied = true;
}

function safe(val) { const n = Number(val); return isFinite(n) ? n : 0; }
function clamp(val, max) { return Math.max(-max, Math.min(max, val)); }
function sanitizeDir(d) {
  d.x = safe(d.x); d.y = safe(d.y); d.z = safe(d.z);
  if (d.x === 0 && d.y === 0 && d.z === 0) d.z = 1;
}


// ============================================================================
// TUNNEL SHELL DECOMPOSITION
// ============================================================================

function elemId(geometry, placement) {
  const data = JSON.stringify({ geometry, placement });
  return 'elem-' + createHash('sha256').update(data).digest('hex').slice(0, 12);
}

function vecNormalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-12 || !isFinite(len)) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function vecDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function vecCross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function vecScale(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }

function vecAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }

function vecSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }

function decomposeTunnelShell(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') {
    console.log('decomposeTunnelShell: skipping non-TUNNEL domain');
    return;
  }

  const WALL_THICKNESS = 0.3;

  let decomposedBranchCount = 0;
  let derivedShellPieceCount = 0;
  let skippedCircularCount = 0;
  let skippedDuctCount = 0;
  let skippedSmallSegments = 0;
  let skippedAlreadyDecomposed = 0;
  let skippedInvalidPlacement = 0;
  let skippedInvalidFrame = 0;
  let spaceSuppressedCount = 0;
  let defaultedThicknessCount = 0;

  const derivedElements = [];

  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT') continue;

    const props = elem.properties || {};

    // Skip ducts/airways
    if (props.branchClass !== 'STRUCTURAL') {
      skippedDuctCount++;
      continue;
    }

    // Duplicate-decomposition guard: skip when ANY of these already exist
    if (props.decompositionMethod || props.derivedFromBranch || props.shellPiece) {
      skippedAlreadyDecomposed++;
      continue;
    }

    // Skip circular tunnels
    const shape = props.shape || '';
    const profileType = elem.geometry?.profile?.type || '';
    if (shape !== 'rectangular' && profileType !== 'RECTANGLE') {
      skippedCircularCount++;
      continue;
    }

    // Required placement/geometry fields
    const placement = elem.placement || {};
    const geometry = elem.geometry || {};
    const profile = geometry.profile || {};
    const W = profile.width;
    const H = profile.height;
    const depth = geometry.depth;

    if (!placement.axis || !placement.refDirection || !W || !H || !depth) {
      skippedInvalidPlacement++;
      continue;
    }

    // Minimum dimension guard
    if (W <= 0.6 || H <= 0.6 || depth <= 0.5) {
      skippedSmallSegments++;
      continue;
    }

    // element_key backfill — the only allowed parent mutation
    if (!elem.element_key) {
      elem.element_key = elemId(geometry, placement);
    }

    // ---- Orthonormal frame construction ----
    const axis = vecNormalize(placement.axis);
    if (!axis) { skippedInvalidFrame++; continue; }

    let rawUp = vecNormalize(placement.refDirection);
    if (!rawUp) { skippedInvalidFrame++; continue; }

    // Parallel-axis guard
    if (Math.abs(vecDot(axis, rawUp)) > 0.95) {
      rawUp = vecNormalize({ x: 0, y: 0, z: 1 });
      if (!rawUp || Math.abs(vecDot(axis, rawUp)) > 0.95) {
        rawUp = vecNormalize({ x: 1, y: 0, z: 0 });
      }
    }
    if (!rawUp) { skippedInvalidFrame++; continue; }

    const side = vecNormalize(vecCross(axis, rawUp));
    if (!side) { skippedInvalidFrame++; continue; }

    const up = vecNormalize(vecCross(side, axis));
    if (!up) { skippedInvalidFrame++; continue; }

    // ---- Shell piece derivation ----
    const parentOrigin = placement.origin;
    const parentKey = elem.element_key;
    const parentContainer = elem.container;
    const parentSource = elem.source || 'VSM';

    // Inherit parent material for structural pieces
    const parentMaterial = elem.material || { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 };
    const spaceMaterial = { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 };

    // Shell pieces definition: [suffix, cssType, semanticType, offsetVec, profileW, profileH, refDir, confidence, extraProps]
    // v2: stable branch frame — ALL pieces use refDir=side (local X=side, local Y=up, local Z=tunnel dir)
    // Offsets are thickness-aware: centers inset by t/2 from outer boundary
    // Slabs span between wall inner faces (W-2t) to avoid corner overlap
    const t = WALL_THICKNESS;
    const slabW = W - 2 * t;

    const pieces = [
      ['left_wall', 'WALL', 'IfcWall', vecScale(side, -(W / 2 - t / 2)), t, H, side, 0.92, {}],
      ['right_wall', 'WALL', 'IfcWall', vecScale(side, (W / 2 - t / 2)), t, H, side, 0.92, {}],
      ['floor', 'SLAB', 'IfcSlab', vecScale(up, -(H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'FLOOR' }],
      ['roof', 'SLAB', 'IfcSlab', vecScale(up, (H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'ROOF' }],
    ];

    // Void space — stable frame, inner clear dimensions
    const innerW = W - 2 * t;
    const innerH = H - 2 * t;
    if (innerW > 0.1 && innerH > 0.1) {
      pieces.push(['void', 'SPACE', 'IfcSpace', { x: 0, y: 0, z: 0 }, innerW, innerH, side, 0.85, {}]);
    } else {
      spaceSuppressedCount++;
    }

    for (const [suffix, cssType, semanticType, offsetVec, profW, profH, refDir, confidence, extraProps] of pieces) {
      // Sanity check offset magnitude
      const offsetMag = Math.sqrt(offsetVec.x * offsetVec.x + offsetVec.y * offsetVec.y + offsetVec.z * offsetVec.z);
      if (offsetMag > Math.max(W, H)) {
        console.warn(`Tunnel shell offset suspicious for branch ${parentKey}: offset=${offsetMag.toFixed(3)}`);
      }

      const derivedOrigin = vecAdd(parentOrigin, offsetVec);
      const derivedPlacement = {
        origin: derivedOrigin,
        axis: { ...axis },
        refDirection: refDir || { ...placement.refDirection }
      };

      const derivedGeometry = {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: depth,
        profile: {
          type: 'RECTANGLE',
          width: profW,
          height: profH
        }
      };

      const derivedId = elemId(derivedGeometry, derivedPlacement);
      const material = cssType === 'SPACE' ? spaceMaterial : { ...parentMaterial };

      const derivedElem = {
        id: derivedId,
        element_key: `${parentKey}_${suffix}`,
        type: cssType,
        semanticType: semanticType,
        confidence: confidence,
        source: parentSource,
        container: parentContainer,
        placement: derivedPlacement,
        geometry: derivedGeometry,
        material: material,
        properties: {
          ...props,
          derivedFromBranch: parentKey,
          shellPiece: suffix.toUpperCase(),
          decompositionMethod: 'rectangular_shell_v1',
          shellThickness_m: WALL_THICKNESS,
          shellThicknessBasis: 'DEFAULT',
          ...extraProps
        },
        relationships: []
      };

      derivedElements.push(derivedElem);
      derivedShellPieceCount++;
      defaultedThicknessCount++;
    }

    decomposedBranchCount++;
  }

  // ---- v3.1: Finite-segment centerline matching — link EQUIPMENT to nearest void space ----

  // Collect all void spaces with their finite centerline segment.
  // The void origin is the branch CENTER (consistent with v2 shell decomposition, which applies
  // shell offsets around this center point). The segment extends ±depth/2 along the axis.
  // Only real emitted VOID spaces are eligible — suppressed voids (innerW/innerH too small)
  // never appear in derivedElements and are excluded automatically.
  // We also store derivedFromBranch so matched equipment can record the structural branch key.
  const EPS = 1e-9;  // floating-point comparison tolerance
  const voidSpaces = [];
  let invalidVoidCandidateCount = 0;  // VOID elements skipped due to missing origin/axis/depth
  for (const d of derivedElements) {
    if (d.properties.shellPiece !== 'VOID') continue;
    const o = d.placement?.origin;
    if (!o) { invalidVoidCandidateCount++; continue; }
    const ax = d.placement.axis;
    if (!ax) { invalidVoidCandidateCount++; continue; }
    // Validate axis is a finite, non-zero unit vector
    const axLen = Math.sqrt(ax.x * ax.x + ax.y * ax.y + ax.z * ax.z);
    if (!Number.isFinite(axLen) || axLen < EPS) { invalidVoidCandidateCount++; continue; }
    const depth = d.geometry?.depth || 0;
    if (depth <= 0) { invalidVoidCandidateCount++; continue; }
    voidSpaces.push({
      key: d.element_key,
      branchKey: d.properties.derivedFromBranch,  // structural parent branch element_key
      cx: o.x, cy: o.y, cz: o.z,                 // segment CENTER (branch midpoint)
      ax: ax.x / axLen, ay: ax.y / axLen, az: ax.z / axLen,  // normalized axis
      halfDepth: depth / 2                         // half segment length
    });
  }

  // Match EQUIPMENT elements to nearest void space by distance to finite centerline segment.
  // For each void: project equipment point onto the axis relative to the branch center,
  // apply along-axis sanity guard, clamp to [-halfDepth, +halfDepth], compute distance
  // to that clamped point.
  //
  // Tie-breaking for ambiguous matches (two voids at similar distance):
  //   1. Primary: smallest finite-segment distance (within EPS tolerance)
  //   2. Secondary: smallest absolute along-axis projection |t| (within EPS tolerance)
  //   3. Tertiary: lexical order of void element_key (deterministic across runs)
  let infrastructureLinkedCount = 0;
  let noVoidAvailableCount = 0;
  const MAX_CONTAINMENT_DISTANCE = 10;  // meters — perpendicular rejection threshold
  const ALONG_AXIS_TOLERANCE = 2.0;     // meters — longitudinal slack beyond segment ends

  for (const elem of css.elements) {
    if ((elem.type || '').toUpperCase() !== 'EQUIPMENT') continue;

    const eqOrigin = elem.placement?.origin;
    if (!eqOrigin) continue;

    if (voidSpaces.length === 0) {
      noVoidAvailableCount++;
      continue;
    }

    // Find nearest void space by distance to its finite centerline segment
    let bestKey = null;
    let bestBranchKey = null;
    let bestDist = Infinity;
    let bestAbsT = Infinity;
    for (const vs of voidSpaces) {
      // Vector from segment center to equipment point
      const dx = eqOrigin.x - vs.cx;
      const dy = eqOrigin.y - vs.cy;
      const dz = eqOrigin.z - vs.cz;
      // Signed projection onto axis: t = dot(P - C, A)  (A is unit-length)
      const t = dx * vs.ax + dy * vs.ay + dz * vs.az;
      // Along-axis sanity guard: reject if equipment is beyond segment + tolerance
      if (Math.abs(t) > vs.halfDepth + ALONG_AXIS_TOLERANCE) continue;
      // Clamp to finite segment [-halfDepth, +halfDepth]
      const tc = Math.max(-vs.halfDepth, Math.min(vs.halfDepth, t));
      // Closest point on segment: C + tc * A
      const cpx = vs.cx + tc * vs.ax;
      const cpy = vs.cy + tc * vs.ay;
      const cpz = vs.cz + tc * vs.az;
      // Distance from equipment to closest point
      const rx = eqOrigin.x - cpx;
      const ry = eqOrigin.y - cpy;
      const rz = eqOrigin.z - cpz;
      const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
      // Epsilon-safe deterministic tie-breaking (null-safe: first candidate always wins via bestKey===null)
      //   1. bestKey===null → first valid candidate, accept unconditionally
      //   2. dist < bestDist - EPS → strictly closer segment distance
      //   3. dist tied (within EPS) AND absT < bestAbsT - EPS → prefer center-aligned
      //   4. dist AND absT both tied (within EPS) → lexically smaller element_key
      const absT = Math.abs(t);
      const dominated =
        bestKey === null ||
        dist < bestDist - EPS ||
        (Math.abs(dist - bestDist) <= EPS && absT < bestAbsT - EPS) ||
        (Math.abs(dist - bestDist) <= EPS && Math.abs(absT - bestAbsT) <= EPS && vs.key < bestKey);
      if (dominated) {
        bestDist = dist;
        bestAbsT = absT;
        bestKey = vs.key;
        bestBranchKey = vs.branchKey;
      }
    }

    if (bestKey && bestDist <= MAX_CONTAINMENT_DISTANCE) {
      if (!elem.metadata) elem.metadata = {};
      // hostSpaceKey = containment target IfcSpace key (read by generator for IfcRelContainedInSpatialStructure)
      // hostVoidSpaceKeyMatched = same key, retained as debug/audit metadata
      // Both are intentionally the same value in this pipeline — one drives containment, the other aids verification.
      elem.metadata.hostSpaceKey = bestKey;
      elem.metadata.hostSpaceDistance = Math.round(bestDist * 100) / 100;
      elem.metadata.hostVoidSpaceKeyMatched = bestKey;
      // hostStructuralBranchMatched = decomposed parent branch key (from derivedFromBranch on the void element)
      elem.metadata.hostStructuralBranchMatched = bestBranchKey;
      infrastructureLinkedCount++;
    } else {
      noVoidAvailableCount++;
    }
  }

  // ---- v6: Cross-section clamping ----
  // TUNNEL domain only. EQUIPMENT only. Only elements with hostVoidSpaceKeyMatched.
  const CLAMP_MARGIN = 0.25;
  let placementCorrectedCount = 0;

  if ((css.domain || '').toUpperCase() === 'TUNNEL') {
    for (const elem of css.elements) {
      if ((elem.type || '').toUpperCase() !== 'EQUIPMENT') continue;
      if (!elem.metadata?.hostVoidSpaceKeyMatched) continue;

      const eqOrigin = elem.placement?.origin;
      if (!eqOrigin) continue;

      const matchedVoidKey = elem.metadata.hostVoidSpaceKeyMatched;
      const voidElem = derivedElements.find(d => d.element_key === matchedVoidKey);
      if (!voidElem) continue;

      const vo = voidElem.placement?.origin;
      const vAxis = voidElem.placement?.axis;
      const vRef = voidElem.placement?.refDirection;
      if (!vo || !vAxis || !vRef) continue;

      const innerW = voidElem.geometry?.profile?.width;
      const innerH = voidElem.geometry?.profile?.height;
      const vDepth = voidElem.geometry?.depth;
      if (!innerW || !innerH || !vDepth || innerW <= 0 || innerH <= 0 || vDepth <= 0) continue;

      const A = vecNormalize(vAxis);
      const R = vecNormalize(vRef);
      if (!A || !R) continue;
      const C = vecNormalize(vecCross(A, R));
      if (!C) continue;

      const dx = eqOrigin.x - vo.x;
      const dy = eqOrigin.y - vo.y;
      const dz = eqOrigin.z - vo.z;

      const localAlong = dx * A.x + dy * A.y + dz * A.z;
      const localX = dx * R.x + dy * R.y + dz * R.z;
      const localY = dx * C.x + dy * C.y + dz * C.z;

      const halfW = Math.max(0, (innerW / 2) - CLAMP_MARGIN);
      const halfH = Math.max(0, (innerH / 2) - CLAMP_MARGIN);
      const halfD = vDepth / 2;
      const clampedX = Math.max(-halfW, Math.min(halfW, localX));
      const clampedY = Math.max(-halfH, Math.min(halfH, localY));
      const clampedAlong = Math.max(-halfD, Math.min(halfD, localAlong));

      const movedX = Math.abs(clampedX - localX) > 0.01;
      const movedY = Math.abs(clampedY - localY) > 0.01;
      const movedAlong = Math.abs(clampedAlong - localAlong) > 0.01;

      if (movedX || movedY || movedAlong) {
        elem.metadata.originalOrigin = { x: eqOrigin.x, y: eqOrigin.y, z: eqOrigin.z };
        elem.metadata.placementCorrected = true;
        elem.metadata.correctionDelta = {
          lateral: Math.round((clampedX - localX) * 100) / 100,
          vertical: Math.round((clampedY - localY) * 100) / 100,
          axial: Math.round((clampedAlong - localAlong) * 100) / 100
        };
        elem.placement.origin = {
          x: vo.x + clampedAlong * A.x + clampedX * R.x + clampedY * C.x,
          y: vo.y + clampedAlong * A.y + clampedX * R.y + clampedY * C.y,
          z: vo.z + clampedAlong * A.z + clampedX * R.z + clampedY * C.z
        };
        placementCorrectedCount++;
      }
    }
  }
  if (placementCorrectedCount > 0) {
    console.log(`v6 Cross-section clamping: ${placementCorrectedCount} equipment elements repositioned inside voids`);
  }

  // Append derived elements after source elements (preserves source ordering)
  if (derivedElements.length > 0) {
    css.elements.push(...derivedElements);
  }

  // Track decomposition stats
  if (!css.metadata) css.metadata = {};
  css.metadata.tunnelDecomposition = {
    decomposedBranchCount,
    derivedShellPieceCount,
    skippedCircularCount,
    skippedDuctCount,
    skippedSmallSegments,
    skippedAlreadyDecomposed,
    skippedInvalidPlacement,
    skippedInvalidFrame,
    spaceSuppressedCount,
    defaultedThicknessCount,
    infrastructureLinkedCount,
    noVoidAvailableCount,
    invalidVoidCandidateCount,
    voidSpaceCount: voidSpaces.length,
    wallThickness_m: WALL_THICKNESS,
    thicknessBasis: 'DEFAULT',
    method: 'rectangular_shell_v1',
    placementCorrectedCount
  };

  console.log(`Tunnel shell decomposition: ${decomposedBranchCount} branches → ${derivedShellPieceCount} shell pieces | Equipment containment: ${infrastructureLinkedCount} linked to ${voidSpaces.length} eligible void spaces (${noVoidAvailableCount} unmatched, ${invalidVoidCandidateCount} invalid void candidates)`);
}


// ============================================================================
// WALL ALIGNMENT + MERGE (Phase 6A)
// ============================================================================

function mergeWalls(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') {
    console.log('MergeWalls: skipping for TUNNEL domain (shell walls are independent)');
    return;
  }

  const ANGLE_TOL = 3 * Math.PI / 180; // 3 degrees
  const SNAP_TOL = 5 * Math.PI / 180;  // 5 degrees for axis snap
  const ENDPOINT_TOL = 0.20; // meters (v3.2: increased from 0.05)
  const THICKNESS_TOL = 0.10; // 10% relative

  // Only process WALL elements
  const walls = css.elements.filter(e => (e.type === 'WALL' || e.semantic_type === 'WALL'));
  if (walls.length < 2) return;

  // Snap direction to dominant axis if within SNAP_TOL
  for (const wall of walls) {
    const dir = wall.geometry?.direction;
    if (!dir) continue;
    const dx = dir.x ?? dir[0] ?? 0;
    const dy = dir.y ?? dir[1] ?? 0;
    const dz = dir.z ?? dir[2] ?? 0;
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (len < 1e-6) continue;
    const nx = dx/len, ny = dy/len, nz = dz/len;
    // Check proximity to cardinal axes
    if (Math.abs(Math.abs(nx) - 1) < Math.sin(SNAP_TOL)) {
      dir.x = Math.sign(nx) || 1; dir.y = 0; dir.z = 0;
    } else if (Math.abs(Math.abs(ny) - 1) < Math.sin(SNAP_TOL)) {
      dir.x = 0; dir.y = Math.sign(ny) || 1; dir.z = 0;
    } else if (Math.abs(Math.abs(nz) - 1) < Math.sin(SNAP_TOL)) {
      dir.x = 0; dir.y = 0; dir.z = Math.sign(nz) || 1;
    }
  }

  // Group walls by container (storey)
  const wallsByContainer = {};
  for (const wall of walls) {
    const cid = wall.container || 'level-1';
    if (!wallsByContainer[cid]) wallsByContainer[cid] = [];
    wallsByContainer[cid].push(wall);
  }

  const mergedKeys = new Set();
  let mergeIndex = 0;

  for (const [containerId, containerWalls] of Object.entries(wallsByContainer)) {
    // Try to merge pairs within same container
    const merged = new Set();
    for (let i = 0; i < containerWalls.length; i++) {
      if (merged.has(i)) continue;
      const a = containerWalls[i];
      for (let j = i + 1; j < containerWalls.length; j++) {
        if (merged.has(j)) continue;
        const b = containerWalls[j];
        if (!canMergeWalls(a, b, ANGLE_TOL, ENDPOINT_TOL, THICKNESS_TOL)) continue;

        // Merge b into a
        const mergedFromA = a.metadata?.mergedFrom || [a.element_key || a.id];
        const mergedFromB = b.metadata?.mergedFrom || [b.element_key || b.id];

        // Compute new merged wall: extend length, average position
        const aOrigin = getOrigin(a);
        const bOrigin = getOrigin(b);
        const aLen = getWallLength(a);
        const bLen = getWallLength(b);
        const aDir = getDir(a);

        // Project b's center onto a's line to find total extent
        const abVec = [bOrigin[0] - aOrigin[0], bOrigin[1] - aOrigin[1], bOrigin[2] - aOrigin[2]];
        const proj = abVec[0]*aDir[0] + abVec[1]*aDir[1] + abVec[2]*aDir[2];

        // Endpoints of a along its direction
        const aStart = -aLen/2;
        const aEnd = aLen/2;
        const bStart = proj - bLen/2;
        const bEnd = proj + bLen/2;

        const newStart = Math.min(aStart, bStart);
        const newEnd = Math.max(aEnd, bEnd);
        const newLen = newEnd - newStart;
        const newMid = (newStart + newEnd) / 2;

        // New origin = a's origin shifted along direction by newMid
        const newOrigin = [
          aOrigin[0] + aDir[0] * newMid,
          aOrigin[1] + aDir[1] * newMid,
          aOrigin[2] + aDir[2] * newMid
        ];

        // Update a with merged values
        setOrigin(a, newOrigin);
        setWallLength(a, newLen);

        if (!a.metadata) a.metadata = {};
        a.metadata.mergedFrom = [...mergedFromA, ...mergedFromB];
        a.element_key = `merged_wall_${containerId}_${mergeIndex++}`;

        mergedKeys.add(b.element_key || b.id);
        merged.add(j);
      }
    }
  }

  // Remove merged-away elements
  if (mergedKeys.size > 0) {
    css.elements = css.elements.filter(e => !mergedKeys.has(e.element_key || e.id));
    console.log(`Merged ${mergedKeys.size} wall segments`);
  }
}

function canMergeWalls(a, b, angleTol, endpointTol, thicknessTol) {
  const dirA = getDir(a);
  const dirB = getDir(b);

  // Check angle between directions (use absolute dot product for anti-parallel)
  const dot = Math.abs(dirA[0]*dirB[0] + dirA[1]*dirB[1] + dirA[2]*dirB[2]);
  if (dot < Math.cos(angleTol)) return false;

  // Check thickness compatibility (within 10%)
  const thickA = getWallThickness(a);
  const thickB = getWallThickness(b);
  if (thickA > 0 && thickB > 0) {
    const ratio = Math.abs(thickA - thickB) / Math.max(thickA, thickB);
    if (ratio > thicknessTol) return false;
  }

  // Check if endpoints are close enough
  const aOrigin = getOrigin(a);
  const bOrigin = getOrigin(b);
  const aLen = getWallLength(a);
  const bLen = getWallLength(b);

  // Compute endpoints of both walls
  const aEnd1 = [aOrigin[0] - dirA[0]*aLen/2, aOrigin[1] - dirA[1]*aLen/2, aOrigin[2] - dirA[2]*aLen/2];
  const aEnd2 = [aOrigin[0] + dirA[0]*aLen/2, aOrigin[1] + dirA[1]*aLen/2, aOrigin[2] + dirA[2]*aLen/2];
  const bEnd1 = [bOrigin[0] - dirB[0]*bLen/2, bOrigin[1] - dirB[1]*bLen/2, bOrigin[2] - dirB[2]*bLen/2];
  const bEnd2 = [bOrigin[0] + dirB[0]*bLen/2, bOrigin[1] + dirB[1]*bLen/2, bOrigin[2] + dirB[2]*bLen/2];

  // Check if any endpoint pair is within tolerance
  const minDist = Math.min(
    dist3(aEnd1, bEnd1), dist3(aEnd1, bEnd2),
    dist3(aEnd2, bEnd1), dist3(aEnd2, bEnd2)
  );
  return minDist <= endpointTol;
}

function getOrigin(elem) {
  const o = elem.placement?.origin || elem.placement?.position || {};
  return [o.x ?? 0, o.y ?? 0, o.z ?? 0];
}

function setOrigin(elem, coords) {
  if (elem.placement?.origin) {
    elem.placement.origin.x = coords[0];
    elem.placement.origin.y = coords[1];
    elem.placement.origin.z = coords[2];
  } else if (elem.placement?.position) {
    elem.placement.position.x = coords[0];
    elem.placement.position.y = coords[1];
    elem.placement.position.z = coords[2];
  }
}

function getDir(elem) {
  const d = elem.geometry?.direction || {};
  const dx = d.x ?? d[0] ?? 1;
  const dy = d.y ?? d[1] ?? 0;
  const dz = d.z ?? d[2] ?? 0;
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  return len > 1e-6 ? [dx/len, dy/len, dz/len] : [1, 0, 0];
}

function getWallLength(elem) {
  return elem.geometry?.depth || elem.geometry?.length_m || 1;
}

function setWallLength(elem, len) {
  if (elem.geometry?.depth !== undefined) elem.geometry.depth = len;
  if (elem.geometry?.length_m !== undefined) elem.geometry.length_m = len;
}

function getWallThickness(elem) {
  const p = elem.geometry?.profile || {};
  return p.width || p.width_m || p.height || p.height_m || 0;
}

function dist3(a, b) {
  return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
}


// ============================================================================
// OPENING INFERENCE (v3.2 — scored host-wall matching)
// ============================================================================

/**
 * Normalize a 3D vector to unit length. Returns [0,0,1] if zero-length.
 */
function normalize(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return len > 1e-9 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 1];
}

/**
 * Dot product of two 3-vectors.
 */
function dot3(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

/**
 * Get the horizontal length of a wall (the long dimension of its profile).
 * Walls are EXTRUSION rectangles: profile = (length × thickness), depth = height.
 */
function getWallHorizontalLength(wall) {
  const p = wall.geometry?.profile;
  if (!p) return wall.geometry?.depth || 1;
  const w = p.width || 1;
  const h = p.height || 1;
  return Math.max(w, h);
}

/**
 * Get the horizontal axis direction of a wall.
 * If profile.width >= profile.height, wall runs along X; otherwise along Y.
 */
function getWallHorizontalAxis(wall) {
  const p = wall.geometry?.profile;
  if (!p) return [1, 0, 0];
  const w = p.width || 1;
  const h = p.height || 1;
  if (w >= h) return [1, 0, 0];
  return [0, 1, 0];
}

/**
 * Get wall endpoints along its horizontal axis.
 */
function getWallHorizontalEndpoints(wall) {
  const origin = getOrigin(wall);
  const axis = getWallHorizontalAxis(wall);
  const halfLen = getWallHorizontalLength(wall) / 2;
  return {
    start: [origin[0] - axis[0]*halfLen, origin[1] - axis[1]*halfLen, origin[2]],
    end:   [origin[0] + axis[0]*halfLen, origin[1] + axis[1]*halfLen, origin[2]]
  };
}

/**
 * Get wall thickness (the short dimension of its profile).
 */
function getWallThicknessFromProfile(wall) {
  const p = wall.geometry?.profile;
  if (!p) return 0.2;
  const w = p.width || 1;
  const h = p.height || 1;
  return Math.min(w, h);
}

/**
 * Get opening width — the wider profile dimension (horizontal extent of the opening).
 */
function getOpeningWidth(elem) {
  const p = elem.geometry?.profile;
  if (!p) return 1;
  const w = p.width || 1;
  const h = p.height || 1;
  return Math.max(w, h);
}

/**
 * Get opening height (the depth of the extrusion = vertical extent).
 */
function getOpeningHeight(elem) {
  return elem.geometry?.depth || elem.geometry?.length_m || 2;
}

/**
 * Get the opening's face normal — the direction it faces through the wall.
 * This is along the thin profile dimension (not the extrusion direction).
 */
function getOpeningNormal(elem) {
  const p = elem.geometry?.profile;
  if (!p) return [0, 1, 0];
  const w = p.width || 1;
  const h = p.height || 1;
  // Thin dimension determines face normal
  if (h <= w) return [0, 1, 0]; // thin in Y → normal along Y
  return [1, 0, 0]; // thin in X → normal along X
}

/**
 * Project a point onto a line segment defined by two endpoints.
 * Returns { t, closest, perpDist } where:
 *   t = parameter along segment (0 = start, 1 = end)
 *   closest = closest point on segment
 *   perpDist = perpendicular distance from point to segment
 */
function projectPointToSegment(point, segStart, segEnd) {
  const seg = [segEnd[0]-segStart[0], segEnd[1]-segStart[1], segEnd[2]-segStart[2]];
  const segLen = Math.sqrt(seg[0]*seg[0] + seg[1]*seg[1] + seg[2]*seg[2]);
  if (segLen < 1e-9) {
    return { t: 0, closest: segStart, perpDist: dist3(point, segStart) };
  }
  const segDir = [seg[0]/segLen, seg[1]/segLen, seg[2]/segLen];
  const toPoint = [point[0]-segStart[0], point[1]-segStart[1], point[2]-segStart[2]];
  const proj = dot3(toPoint, segDir);
  const t = proj / segLen; // 0..1 along segment
  const tClamped = Math.max(0, Math.min(1, t));
  const closest = [
    segStart[0] + segDir[0] * tClamped * segLen,
    segStart[1] + segDir[1] * tClamped * segLen,
    segStart[2] + segDir[2] * tClamped * segLen
  ];
  const perpDist = dist3(point, closest);
  return { t, tClamped, closest, perpDist, proj, segLen };
}

/**
 * Get wall endpoints along horizontal axis (used by opening matching).
 * Delegates to getWallHorizontalEndpoints.
 */
function getWallEndpoints(wall) {
  return getWallHorizontalEndpoints(wall);
}

function inferOpenings(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') {
    console.log('InferOpenings: skipping for TUNNEL domain (no wall-hosted openings in tunnels)');
    return;
  }

  const PERP_DIST_MAX = 1.0;         // max perpendicular distance to wall line
  const SEGMENT_TOL = 0.2;           // opening can extend 0.2m past wall endpoints
  const ORIENTATION_TOL = 0.2;       // |dot(openingNormal, wallAxis)| must be < this
  const WIDTH_RATIO_MAX = 0.8;       // opening width must be < 80% of wall length
  const AMBIGUITY_RATIO = 0.7;       // if best/second-best > this, skip (ambiguous)
  const SALVAGE_PERP_MAX = 1.5;      // salvage pass: max perpendicular distance
  const SALVAGE_SEGMENT_TOL = 0.5;   // salvage: projected point must be within segment ± this

  // Get structure class from metadata (set by builting-extract)
  const structureClass = (css.metadata?.structureClass || 'BUILDING').toUpperCase();

  const walls = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return t === 'WALL'; // only semantic WALLs, never PROXY
  });
  const openingCandidates = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return t === 'DOOR' || t === 'WINDOW';
  });

  if (walls.length === 0 || openingCandidates.length === 0) {
    // LINEAR structures: openings should not exist, skip all
    if (structureClass === 'LINEAR' && openingCandidates.length > 0) {
      _skipAllOpenings(css, openingCandidates, 'linear_structure_no_openings');
    }
    return;
  }

  // LINEAR structures: skip all openings
  if (structureClass === 'LINEAR') {
    _skipAllOpenings(css, openingCandidates, 'linear_structure_no_openings');
    return;
  }

  css.metadata = css.metadata || {};
  css.metadata.skippedOpenings = css.metadata.skippedOpenings || [];

  let matched = 0;
  let skipped = 0;
  const toRemove = new Set();

  for (const candidate of openingCandidates) {
    const result = _scoreOpeningAgainstWalls(candidate, walls, {
      PERP_DIST_MAX, SEGMENT_TOL, ORIENTATION_TOL, WIDTH_RATIO_MAX, AMBIGUITY_RATIO
    });

    if (result.matched) {
      if (!candidate.metadata) candidate.metadata = {};
      candidate.metadata.hostWallKey = result.wallKey;
      candidate.metadata.hostWallMatchScore = result.score;
      // Align opening orientation and position to host wall
      _alignOpeningToWall(candidate, walls, result.wallKey);
      matched++;
      continue;
    }

    // Salvage pass: try snapping to nearest wall centerline
    const salvageResult = _salvageOpening(candidate, walls, {
      SALVAGE_PERP_MAX, SALVAGE_SEGMENT_TOL,
      PERP_DIST_MAX, SEGMENT_TOL, ORIENTATION_TOL, WIDTH_RATIO_MAX, AMBIGUITY_RATIO
    });

    if (salvageResult.matched) {
      if (!candidate.metadata) candidate.metadata = {};
      candidate.metadata.hostWallKey = salvageResult.wallKey;
      candidate.metadata.hostWallMatchScore = salvageResult.score;
      candidate.metadata.salvageSnapped = true;
      // Apply the snap
      setOrigin(candidate, salvageResult.snappedOrigin);
      // Align opening orientation to host wall
      _alignOpeningToWall(candidate, walls, salvageResult.wallKey);
      matched++;
      continue;
    }

    // No match — skip the opening
    const skipReason = result.rejectReason || salvageResult.rejectReason || 'no_wall_match';
    if (structureClass === 'BUILDING' || structureClass === 'FACILITY') {
      toRemove.add(candidate.id || candidate.element_key);
      css.metadata.skippedOpenings.push({
        id: candidate.id || candidate.element_key,
        type: (candidate.type || '').toUpperCase(),
        skipReason,
        hostWallRejectReason: result.rejectReason
      });
      skipped++;
    }
  }

  // Remove skipped openings from elements
  if (toRemove.size > 0) {
    css.elements = css.elements.filter(e => !toRemove.has(e.id || e.element_key));
  }

  // Window alignment heuristic: snap WINDOW sill heights on same wall
  _alignWindowSillHeights(css);

  console.log(`Opening inference: ${matched} matched, ${skipped} skipped`);
}

/**
 * Align an opening's orientation and perpendicular position to its host wall.
 * Sets refDirection to match wall horizontal axis and snaps origin to wall centerline.
 */
function _alignOpeningToWall(opening, walls, wallKey) {
  const hostWall = walls.find(w => (w.element_key || w.id) === wallKey);
  if (!hostWall) return;

  const wallAxis = getWallHorizontalAxis(hostWall);
  if (!opening.placement) opening.placement = {};
  opening.placement.refDirection = { x: wallAxis[0], y: wallAxis[1], z: 0 };
  opening.placement.axis = { x: 0, y: 0, z: 1 };

  // Snap opening origin's perpendicular coordinate to wall centerline
  const openingOrigin = getOrigin(opening);
  const { start, end } = getWallEndpoints(hostWall);
  const { closest } = projectPointToSegment(openingOrigin, start, end);
  setOrigin(opening, [closest[0], closest[1], openingOrigin[2]]);
}

/**
 * Score an opening against all candidate walls. Returns best match or rejection.
 */
function _scoreOpeningAgainstWalls(opening, walls, opts) {
  const openingOrigin = getOrigin(opening);
  const openingContainer = opening.container || 'level-1';
  const openingWidth = getOpeningWidth(opening);
  const openingNormal = normalize(getOpeningNormal(opening));

  const scores = [];

  for (const wall of walls) {
    const wallContainer = wall.container || 'level-1';
    if (wallContainer !== openingContainer) continue;

    const wallType = (wall.type || wall.semantic_type || '').toUpperCase();
    if (wallType !== 'WALL') continue;

    const wallDir = normalize(getWallHorizontalAxis(wall));
    const wallLength = getWallHorizontalLength(wall);
    const { start, end } = getWallEndpoints(wall);

    // Hard rejection: opening wider than 80% of wall
    if (openingWidth >= wallLength * opts.WIDTH_RATIO_MAX) continue;

    // Orientation check: opening normal should be perpendicular to wall axis.
    // Try both profile-derived normal and its perpendicular, since the LLM
    // uses a consistent width>height convention regardless of wall orientation.
    const orientDot = Math.abs(dot3(openingNormal, wallDir));
    const altNormal = [openingNormal[1], openingNormal[0], openingNormal[2]]; // swap X/Y
    const altOrientDot = Math.abs(dot3(altNormal, wallDir));
    if (orientDot > opts.ORIENTATION_TOL && altOrientDot > opts.ORIENTATION_TOL) continue;

    // Perpendicular distance check
    const { perpDist, t, proj, segLen } = projectPointToSegment(openingOrigin, start, end);
    if (perpDist > opts.PERP_DIST_MAX) continue;

    // Projection bounds check: opening center must project within wall ± tolerance
    const halfOpeningWidth = openingWidth / 2;
    const projStart = proj - halfOpeningWidth;
    const projEnd = proj + halfOpeningWidth;
    if (projStart < -opts.SEGMENT_TOL || projEnd > segLen + opts.SEGMENT_TOL) continue;

    // Coverage: how centered is the opening on the wall
    const projectionCoverage = 1 - Math.abs(proj / segLen - 0.5) * 2; // 1=centered, 0=edge

    // Score: lower is better
    const score = perpDist * 1.0
      + (1.0 - Math.max(0, projectionCoverage)) * 0.5
      + (openingWidth / wallLength) * 0.3;

    scores.push({
      wall,
      wallKey: wall.element_key || wall.id,
      score,
      perpDist
    });
  }

  if (scores.length === 0) {
    return { matched: false, rejectReason: 'no_candidate_walls_passed_rejection' };
  }

  scores.sort((a, b) => a.score - b.score);

  // Ambiguity check
  if (scores.length >= 2) {
    const ratio = scores[0].score / scores[1].score;
    if (ratio > opts.AMBIGUITY_RATIO) {
      return { matched: false, rejectReason: 'ambiguous_match' };
    }
  }

  return { matched: true, wallKey: scores[0].wallKey, score: scores[0].score };
}

/**
 * Salvage pass: snap opening to nearest wall centerline and retry matching.
 */
function _salvageOpening(opening, walls, opts) {
  const openingOrigin = getOrigin(opening);
  const openingContainer = opening.container || 'level-1';

  let bestWall = null;
  let bestPerpDist = Infinity;
  let bestClosest = null;
  let bestProj = null;
  let bestSegLen = null;

  for (const wall of walls) {
    if ((wall.container || 'level-1') !== openingContainer) continue;
    const { start, end } = getWallEndpoints(wall);
    const { perpDist, closest, proj, segLen } = projectPointToSegment(openingOrigin, start, end);

    if (perpDist > opts.SALVAGE_PERP_MAX) continue;

    // Safety bound: projected point must be within segment bounds ± tolerance
    if (proj < -opts.SALVAGE_SEGMENT_TOL || proj > segLen + opts.SALVAGE_SEGMENT_TOL) continue;

    if (perpDist < bestPerpDist) {
      bestPerpDist = perpDist;
      bestWall = wall;
      bestClosest = closest;
      bestProj = proj;
      bestSegLen = segLen;
    }
  }

  if (!bestWall || !bestClosest) {
    return { matched: false, rejectReason: 'salvage_no_nearby_wall' };
  }

  // Snap opening center to wall centerline
  const snappedOrigin = [bestClosest[0], bestClosest[1], openingOrigin[2]]; // keep Z

  // Retry scoring with snapped position
  const tempOpening = JSON.parse(JSON.stringify(opening));
  setOrigin(tempOpening, snappedOrigin);

  const result = _scoreOpeningAgainstWalls(tempOpening, walls, {
    PERP_DIST_MAX: opts.PERP_DIST_MAX,
    SEGMENT_TOL: opts.SEGMENT_TOL,
    ORIENTATION_TOL: opts.ORIENTATION_TOL,
    WIDTH_RATIO_MAX: opts.WIDTH_RATIO_MAX,
    AMBIGUITY_RATIO: opts.AMBIGUITY_RATIO
  });

  if (result.matched) {
    return { ...result, snappedOrigin };
  }
  return { matched: false, rejectReason: 'salvage_retry_failed' };
}

/**
 * Remove all openings (for LINEAR structures).
 */
function _skipAllOpenings(css, openings, reason) {
  css.metadata = css.metadata || {};
  css.metadata.skippedOpenings = css.metadata.skippedOpenings || [];

  const ids = new Set();
  for (const o of openings) {
    const oid = o.id || o.element_key;
    ids.add(oid);
    css.metadata.skippedOpenings.push({
      id: oid,
      type: (o.type || '').toUpperCase(),
      skipReason: reason
    });
  }
  css.elements = css.elements.filter(e => !ids.has(e.id || e.element_key));
  console.log(`Skipped all ${openings.length} openings: ${reason}`);
}

/**
 * Window alignment heuristic: snap WINDOW sill heights (Z positions) within tolerance.
 * DOORS are excluded — they sit at floor level and should not be aligned with windows.
 */
function _alignWindowSillHeights(css) {
  const ALIGN_TOL = 0.15; // meters

  // Group windows by host wall
  const windowsByWall = {};
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t !== 'WINDOW') continue;
    const wallKey = elem.metadata?.hostWallKey;
    if (!wallKey) continue;
    if (!windowsByWall[wallKey]) windowsByWall[wallKey] = [];
    windowsByWall[wallKey].push(elem);
  }

  for (const [wallKey, windows] of Object.entries(windowsByWall)) {
    if (windows.length < 2) continue;

    // Get Z values
    const zValues = windows.map(w => (w.placement?.origin?.z ?? 0));
    const avgZ = zValues.reduce((a, b) => a + b, 0) / zValues.length;

    // Snap all to average if within tolerance
    for (let i = 0; i < windows.length; i++) {
      if (Math.abs(zValues[i] - avgZ) <= ALIGN_TOL) {
        if (windows[i].placement?.origin) {
          windows[i].placement.origin.z = avgZ;
        }
      }
    }
  }
}


// ============================================================================
// OPENING RELATIONSHIPS — VALIDATED VOIDS CREATION (v3.2 Task 2)
// ============================================================================

function createOpeningRelationships(css) {
  if (!css.elements || css.elements.length === 0) return;

  const structureClass = (css.metadata?.structureClass || 'BUILDING').toUpperCase();
  css.metadata = css.metadata || {};
  css.metadata.skippedOpenings = css.metadata.skippedOpenings || [];

  // Build a map of walls by key for quick lookup
  const wallMap = {};
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t === 'WALL') {
      wallMap[elem.element_key || elem.id] = elem;
    }
  }

  // Get storey heights for validation
  const storeyHeights = {};
  for (const level of (css.levelsOrSegments || [])) {
    storeyHeights[level.id] = level.height_m || 3;
  }

  const toRemove = new Set();
  let created = 0;
  let skipped = 0;

  const openings = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return (t === 'DOOR' || t === 'WINDOW') && e.metadata?.hostWallKey;
  });

  for (const opening of openings) {
    const wallKey = opening.metadata.hostWallKey;
    const hostWall = wallMap[wallKey];

    // Host wall must still exist
    if (!hostWall) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'host_wall_missing');
      skipped++;
      continue;
    }

    const openingWidth = getOpeningWidth(opening);
    const openingHeight = getOpeningHeight(opening);
    const wallLength = getWallHorizontalLength(hostWall);
    const storeyHeight = storeyHeights[opening.container || 'level-1'] || 3;

    // Validation: opening width < min(10m, wallLength * 0.7)
    if (openingWidth >= Math.min(10, wallLength * 0.7)) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_too_wide_for_wall');
      skipped++;
      continue;
    }

    // Validation: opening width < 80% of usable wall span (wall minus 0.6m margins)
    const usableSpan = wallLength - 0.6;
    if (usableSpan > 0 && openingWidth >= usableSpan * 0.8) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_exceeds_usable_span');
      skipped++;
      continue;
    }

    // Validation: opening height + sill height <= storey height
    const sillHeight = (opening.placement?.origin?.z ?? 0) -
      ((css.levelsOrSegments || []).find(l => l.id === opening.container)?.elevation_m ?? 0);
    if (openingHeight + Math.max(0, sillHeight) > storeyHeight + 0.2) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_exceeds_storey_height');
      skipped++;
      continue;
    }

    // Validation: opening not within 0.15m of wall endpoint
    const { start, end } = getWallEndpoints(hostWall);
    const openingOrigin = getOrigin(opening);
    const { proj, segLen } = projectPointToSegment(openingOrigin, start, end);
    const halfWidth = openingWidth / 2;
    if (proj - halfWidth < 0.15 || proj + halfWidth > segLen - 0.15) {
      // Only skip if wall is long enough that this matters
      if (wallLength > openingWidth + 0.6) {
        _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_too_close_to_wall_edge');
        skipped++;
        continue;
      }
    }

    // Clamp opening profile thickness to wall thickness so it doesn't protrude
    const wallThick = getWallThicknessFromProfile(hostWall);
    const p = opening.geometry?.profile;
    if (p && wallThick > 0) {
      const pw = p.width || 1;
      const ph = p.height || 1;
      const thinDim = Math.min(pw, ph);
      if (thinDim > wallThick) {
        if (pw <= ph) {
          p.width = wallThick;
        } else {
          p.height = wallThick;
        }
      }
    }

    // All checks passed — create VOIDS relationship
    if (!opening.relationships) opening.relationships = [];
    opening.relationships.push({ type: 'VOIDS', target: hostWall.id || hostWall.element_key });
    if (!opening.metadata) opening.metadata = {};
    opening.metadata.openingVoidsCreated = true;
    created++;
  }

  // Remove skipped openings
  if (toRemove.size > 0) {
    css.elements = css.elements.filter(e => !toRemove.has(e.id || e.element_key));
  }

  console.log(`VOIDS relationships: ${created} created, ${skipped} skipped`);
}

/**
 * Skip an opening during VOIDS creation. For BUILDING/FACILITY: remove from elements.
 */
function _skipOpeningVoids(css, opening, toRemove, structureClass, reason) {
  const oid = opening.id || opening.element_key;
  if (structureClass === 'BUILDING' || structureClass === 'FACILITY') {
    toRemove.add(oid);
  }
  css.metadata.skippedOpenings.push({
    id: oid,
    type: (opening.type || '').toUpperCase(),
    skipReason: reason,
    phase: 'voids_creation'
  });
}


// ============================================================================
// SLAB INFERENCE (Phase 6C)
// ============================================================================

function inferSlabs(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') {
    console.log('InferSlabs: skipping for TUNNEL domain (shell slabs pre-classified)');
    return;
  }

  let upgraded = 0;
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t !== 'SLAB') continue;

    // Ensure slab has a PredefinedType
    if (!elem.properties) elem.properties = {};
    if (!elem.properties.slabType) {
      // Determine floor vs roof based on storey position
      const levels = css.levelsOrSegments || [];
      const container = elem.container || 'level-1';
      const levelIndex = levels.findIndex(l => l.id === container);

      if (levelIndex === levels.length - 1 && levels.length > 1 && levelIndex > 0) {
        elem.properties.slabType = 'ROOF';
      } else {
        elem.properties.slabType = 'FLOOR';
      }
      upgraded++;
    }
  }

  if (upgraded > 0) {
    console.log(`Assigned slabType to ${upgraded} slab elements`);
  }
}


// ============================================================================
// ENVELOPE FALLBACK (v3.2)
// ============================================================================

function checkEnvelopeFallback(css) {
  if (!css.metadata) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') return;

  const skippedOpenings = css.metadata.skippedOpenings || [];
  const totalOpeningsOriginal = skippedOpenings.length + css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return t === 'DOOR' || t === 'WINDOW';
  }).length;

  // Calculate opening removal ratio
  const openingsRemovedRatio = totalOpeningsOriginal > 0
    ? skippedOpenings.length / totalOpeningsOriginal
    : 0;

  // Count remaining structural elements (walls, slabs, rooms)
  const structuralTypes = new Set(['WALL', 'SLAB', 'SPACE', 'COLUMN']);
  const structuralRemaining = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return structuralTypes.has(t);
  }).length;

  // v3.2: Trigger ONLY when BOTH conditions are true
  if (openingsRemovedRatio >= 0.5 && structuralRemaining < 4) {
    console.log(`Envelope fallback triggered: ${(openingsRemovedRatio * 100).toFixed(0)}% openings removed, ${structuralRemaining} structural elements remaining`);

    // Keep only walls and slabs, remove everything else
    css.elements = css.elements.filter(e => {
      const t = (e.type || e.semantic_type || '').toUpperCase();
      return t === 'WALL' || t === 'SLAB';
    });

    css.metadata.envelopeFallback = true;
  }
}

// ============================================================================
// v6: BUILDING STRUCTURAL VALIDATION
// ============================================================================

function validateBuildingStructure(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') return;

  const bbox = css.metadata?.bbox;
  if (!bbox) return;

  const warnings = [];
  const STOREY_Z_TOL = 0.5; // elements should be within ±0.5m of storey elevation

  // Build storey elevation map
  const storeyElevations = {};
  for (const level of css.levelsOrSegments || []) {
    storeyElevations[level.id] = level.elevation_m || 0;
  }

  // Check exterior wall completeness
  const extWalls = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'WALL' && e.properties?.isExternal
  );
  if (extWalls.length < 4) {
    warnings.push(`Only ${extWalls.length} exterior walls (minimum 4 expected)`);
  }

  // Check elements outside footprint
  let outsideCount = 0;
  for (const elem of css.elements) {
    const o = elem.placement?.origin;
    if (!o) continue;
    const margin = 5.0; // allow 5m beyond bbox for sections/overhangs
    if (o.x < bbox.min.x - margin || o.x > bbox.max.x + margin ||
        o.y < bbox.min.y - margin || o.y > bbox.max.y + margin) {
      outsideCount++;
    }
  }
  if (outsideCount > 0) {
    warnings.push(`${outsideCount} elements outside building footprint (with 5m margin)`);
  }

  // Check storey-z consistency
  let storeyInconsistentCount = 0;
  for (const elem of css.elements) {
    const container = elem.container;
    if (!container || !storeyElevations.hasOwnProperty(container)) continue;
    const expectedZ = storeyElevations[container];
    const actualZ = elem.placement?.origin?.z;
    if (actualZ !== undefined && Math.abs(actualZ - expectedZ) > STOREY_Z_TOL + (storeyElevations[container] || 3)) {
      storeyInconsistentCount++;
    }
  }
  if (storeyInconsistentCount > 0) {
    warnings.push(`${storeyInconsistentCount} elements have z inconsistent with their storey elevation`);
  }

  if (warnings.length > 0) {
    console.warn(`v6 Building validation: ${warnings.join('; ')}`);
    if (!css.metadata) css.metadata = {};
    css.metadata.buildingValidationWarnings = warnings;
  }
}
