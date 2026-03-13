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
  ambiguousProfileCount = 0; // reset per invocation

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

  // ========== STEP 3C: TUNNEL SHELL CONTINUITY ALIGNMENT ==========
  alignShellContinuity(css);

  // ========== STEP 3D: SHELL EXTENSION AT JUNCTIONS ==========
  extendShellAtJunctions(css);

  // ========== STEP 3E: JUNCTION TRANSITION HELPERS ==========
  generateJunctionTransitions(css);

  // ========== STEP 3F: EQUIPMENT MOUNTING (universal) ==========
  applyEquipmentMounting(css);

  // ========== STEP 4: MERGE WALLS ==========
  mergeWalls(css);
  console.log('Wall merge complete');

  // ========== STEP 5: INFER OPENINGS ==========
  inferOpenings(css);
  console.log('Opening inference complete');

  // ========== STEP 5B: CREATE OPENING RELATIONSHIPS (VOIDS) ==========
  createOpeningRelationships(css);
  console.log('Opening relationships complete');

  // ========== STEP 5C: OPENING PLACEMENT VALIDATION ==========
  validateOpeningPlacement(css);

  // ========== STEP 6: INFER SLABS ==========
  inferSlabs(css);
  console.log('Slab inference complete');

  // ========== STEP 6B: BUILDING ENVELOPE GUARANTEE ==========
  guaranteeBuildingEnvelope(css);

  // ========== STEP 6C: WALL AXIS CLEANUP ==========
  cleanBuildingWallAxes(css);

  // ========== STEP 7: ENVELOPE FALLBACK CHECK (v3.2) ==========
  checkEnvelopeFallback(css);

  // ========== STEP 7B: BUILDING STRUCTURAL VALIDATION (v6) ==========
  validateBuildingStructure(css);

  // ========== STEP 7C: DIMENSION VALIDATION (universal) ==========
  clampAbsurdDimensions(css);

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

  // Track ambiguous wall profiles for upstream extraction quality monitoring
  if (ambiguousProfileCount > 0) {
    console.log(`Transform: ${ambiguousProfileCount} wall(s) had ambiguous profiles (width ≈ height). Consider improving upstream extraction.`);
    css.metadata.ambiguousWallProfiles = ambiguousProfileCount;
  }

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

function vecDist(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2); }

function generateCirclePoints(radius, n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    points.push({ x: +(radius * Math.cos(angle)).toFixed(4), y: +(radius * Math.sin(angle)).toFixed(4) });
  }
  return points;
}

function generateHorseshoePoints(w, h, archSegs) {
  const points = [];
  const halfW = w / 2;
  points.push({ x: -halfW, y: 0 });
  points.push({ x: halfW, y: 0 });
  points.push({ x: halfW, y: +(h * 0.5).toFixed(4) });
  for (let i = 0; i <= archSegs; i++) {
    const angle = Math.PI * i / archSegs;
    points.push({ x: +(halfW * Math.cos(angle)).toFixed(4), y: +(h * 0.5 + halfW * Math.sin(angle)).toFixed(4) });
  }
  points.push({ x: -halfW, y: +(h * 0.5).toFixed(4) });
  return points;
}

// ---- Curved shell arc profile generators ----
// All profiles are in the local cross-section plane (local X=side, local Y=up)
// centered at the tunnel axis origin. Each returns a closed polygon (ARBITRARY profile).

function generateLeftWallArcProfile(R, t, segments) {
  // Left half-annulus: outer arc from π/2→3π/2 (top→left→bottom), inner arc reversed
  const points = [];
  const innerR = R - t;
  for (let i = 0; i <= segments; i++) {
    const angle = Math.PI / 2 + Math.PI * i / segments;
    points.push({ x: +(R * Math.cos(angle)).toFixed(4), y: +(R * Math.sin(angle)).toFixed(4) });
  }
  for (let i = segments; i >= 0; i--) {
    const angle = Math.PI / 2 + Math.PI * i / segments;
    points.push({ x: +(innerR * Math.cos(angle)).toFixed(4), y: +(innerR * Math.sin(angle)).toFixed(4) });
  }
  return points;
}

function generateRightWallArcProfile(R, t, segments) {
  // Right half-annulus: outer arc from -π/2→π/2 (bottom→right→top), inner arc reversed
  const points = [];
  const innerR = R - t;
  for (let i = 0; i <= segments; i++) {
    const angle = -Math.PI / 2 + Math.PI * i / segments;
    points.push({ x: +(R * Math.cos(angle)).toFixed(4), y: +(R * Math.sin(angle)).toFixed(4) });
  }
  for (let i = segments; i >= 0; i--) {
    const angle = -Math.PI / 2 + Math.PI * i / segments;
    points.push({ x: +(innerR * Math.cos(angle)).toFixed(4), y: +(innerR * Math.sin(angle)).toFixed(4) });
  }
  return points;
}

function generateRoofArcProfile(halfW, wallH, archHeight, t, segments) {
  // Horseshoe roof arch: outer arc from π→0 (left→top→right) at y=wallH, inner arc reversed
  // archHeight = radius of arch (typically = halfW)
  const points = [];
  const baseY = wallH;
  const innerHalfW = halfW - t;
  const innerArchH = archHeight - t;
  // Outer arch
  for (let i = 0; i <= segments; i++) {
    const angle = Math.PI - Math.PI * i / segments;
    points.push({ x: +(halfW * Math.cos(angle)).toFixed(4), y: +(baseY + archHeight * Math.sin(angle)).toFixed(4) });
  }
  // Inner arch reversed
  for (let i = segments; i >= 0; i--) {
    const angle = Math.PI - Math.PI * i / segments;
    points.push({ x: +(innerHalfW * Math.cos(angle)).toFixed(4), y: +(baseY + innerArchH * Math.sin(angle)).toFixed(4) });
  }
  return points;
}

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
  let circularVoidCount = 0;
  let horseshoeVoidCount = 0;
  let curvedShellCount = 0;

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

    // Handle non-rectangular tunnels: shell pieces stay RECTANGLE, void gets polygon profile
    const shape = props.shape || '';
    const profileType = elem.geometry?.profile?.type || '';
    let isApproximated = false;
    let approximationType = null;
    let curvedVoidProfile = null; // polygon profile for VOID if non-rectangular

    if (shape !== 'rectangular' && profileType !== 'RECTANGLE') {
      const profile = elem.geometry?.profile || {};
      if (profile.radius && profile.radius > 0) {
        const diameter = profile.radius * 2;
        profile.width = diameter;
        profile.height = diameter;
        profile.type = 'RECTANGLE';
        isApproximated = true;
        // Determine curved void profile
        const innerRadius = profile.radius - WALL_THICKNESS;
        if (innerRadius > 0.1) {
          if (shape === 'horseshoe') {
            const innerW = diameter - 2 * WALL_THICKNESS;
            const innerH = diameter - 2 * WALL_THICKNESS;
            curvedVoidProfile = { type: 'ARBITRARY', points: generateHorseshoePoints(innerW, innerH, 12) };
            approximationType = 'HORSESHOE_TO_RECT';
            horseshoeVoidCount++;
          } else {
            curvedVoidProfile = { type: 'ARBITRARY', points: generateCirclePoints(innerRadius, 16) };
            approximationType = 'CIRCULAR_TO_RECT';
            circularVoidCount++;
          }
        } else {
          approximationType = shape === 'horseshoe' ? 'HORSESHOE_TO_RECT' : 'CIRCULAR_TO_RECT';
        }
      } else if (profile.width && profile.height) {
        profile.type = 'RECTANGLE';
        isApproximated = true;
        approximationType = `${(shape || 'UNKNOWN').toUpperCase()}_TO_RECT`;
      } else {
        skippedCircularCount++;
        continue;
      }
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

    // Shell pieces definition: [suffix, cssType, semanticType, offsetVec, profileW, profileH, refDir, confidence, extraProps, curvedProfile]
    // v2: stable branch frame — ALL pieces use refDir=side (local X=side, local Y=up, local Z=tunnel dir)
    // Offsets are thickness-aware: centers inset by t/2 from outer boundary
    // Slabs span between wall inner faces (W-2t) to avoid corner overlap
    const t = WALL_THICKNESS;
    const slabW = W - 2 * t;

    let pieces;
    const ARC_SEGMENTS = 12;

    if (isApproximated && approximationType === 'CIRCULAR_TO_RECT') {
      // CIRCULAR TUNNEL: 2 curved half-annulus walls + void (no separate floor/roof)
      // Place walls at tunnel center (offset=0) with arc profiles that include position
      const R = W / 2;  // outer radius = half diameter
      const leftProfile = { type: 'ARBITRARY', points: generateLeftWallArcProfile(R, t, ARC_SEGMENTS) };
      const rightProfile = { type: 'ARBITRARY', points: generateRightWallArcProfile(R, t, ARC_SEGMENTS) };
      pieces = [
        ['left_wall', 'WALL', 'IfcWall', { x: 0, y: 0, z: 0 }, W, H, side, 0.92, { geometryApproximation: 'CIRCULAR_ARC_SHELL' }, leftProfile],
        ['right_wall', 'WALL', 'IfcWall', { x: 0, y: 0, z: 0 }, W, H, side, 0.92, { geometryApproximation: 'CIRCULAR_ARC_SHELL' }, rightProfile],
        // Floor slab as thin chord at bottom (structural reference)
        ['floor', 'SLAB', 'IfcSlab', vecScale(up, -(H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'FLOOR' }],
      ];
      curvedShellCount += 2;
    } else if (isApproximated && approximationType === 'HORSESHOE_TO_RECT') {
      // HORSESHOE TUNNEL: rectangular left/right walls + curved roof arch + flat floor
      const halfW = W / 2;
      const wallH = H * 0.5;  // straight wall height (lower half)
      const archH = halfW;    // arch height = half-width (semicircular top)
      const roofProfile = { type: 'ARBITRARY', points: generateRoofArcProfile(halfW, wallH, archH, t, ARC_SEGMENTS) };
      pieces = [
        ['left_wall', 'WALL', 'IfcWall', vecScale(side, -(W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['right_wall', 'WALL', 'IfcWall', vecScale(side, (W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['floor', 'SLAB', 'IfcSlab', vecScale(up, -(H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'FLOOR' }],
        // Roof uses curved arch profile, placed at tunnel center
        ['roof', 'SLAB', 'IfcSlab', { x: 0, y: 0, z: 0 }, slabW, t, side, 0.92, { slabType: 'ROOF', geometryApproximation: 'HORSESHOE_ARCH_SHELL' }, roofProfile],
      ];
      curvedShellCount += 1;
    } else {
      // RECTANGULAR TUNNEL: standard 4-piece decomposition
      pieces = [
        ['left_wall', 'WALL', 'IfcWall', vecScale(side, -(W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['right_wall', 'WALL', 'IfcWall', vecScale(side, (W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['floor', 'SLAB', 'IfcSlab', vecScale(up, -(H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'FLOOR' }],
        ['roof', 'SLAB', 'IfcSlab', vecScale(up, (H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'ROOF' }],
      ];
    }

    // Void space — stable frame, inner clear dimensions
    const innerW = W - 2 * t;
    const innerH = H - 2 * t;
    if (innerW > 0.1 && innerH > 0.1) {
      const voidExtraProps = {};
      if (curvedVoidProfile) {
        voidExtraProps.geometryApproximation = shape === 'horseshoe' ? 'HORSESHOE_POLYGON' : 'CIRCULAR_POLYGON_16';
      }
      pieces.push(['void', 'SPACE', 'IfcSpace', { x: 0, y: 0, z: 0 }, innerW, innerH, side, 0.85, voidExtraProps]);
    } else {
      spaceSuppressedCount++;
    }

    for (const [suffix, cssType, semanticType, offsetVec, profW, profH, refDir, confidence, extraProps, curvedShellProfile] of pieces) {
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

      // Use curved polygon profile for shell pieces or VOID if available, else RECTANGLE
      let derivedProfile;
      if (curvedShellProfile) {
        derivedProfile = { ...curvedShellProfile };
      } else if (suffix === 'void' && curvedVoidProfile) {
        derivedProfile = { ...curvedVoidProfile };
      } else {
        derivedProfile = { type: 'RECTANGLE', width: profW, height: profH };
      }

      const derivedGeometry = {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: depth,
        profile: derivedProfile
      };

      const derivedId = elemId(derivedGeometry, derivedPlacement);
      const material = cssType === 'SPACE' ? spaceMaterial : { ...parentMaterial };

      const derivedElem = {
        id: derivedId,
        element_key: `${parentKey}_${suffix}`,
        type: cssType,
        name: elem.name || elem.id || parentKey,
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
          decompositionMethod: isApproximated ? 'approximated_shell_v1' : 'rectangular_shell_v1',
          ...(isApproximated && suffix !== 'void' ? { geometryApproximation: 'RECT_INSCRIBED_IN_' + (approximationType || 'CURVED').replace('_TO_RECT', '') } : {}),
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

  // v8: Shell decomposition QA logging
  if (derivedShellPieceCount > 0) {
    const sampleDerived = derivedElements.slice(0, 3);
    console.log(`Shell decomposition: ${decomposedBranchCount} branches → ${derivedShellPieceCount} shell pieces`);
    console.log(`  Sample derived elements:`);
    for (const d of sampleDerived) {
      console.log(`    ${d.properties.shellPiece}: name="${d.name}", key="${d.element_key}", derivedFrom="${d.properties.derivedFromBranch}"`);
    }
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

  // Track curved geometry approximations
  if (circularVoidCount > 0 || horseshoeVoidCount > 0 || curvedShellCount > 0) {
    css.metadata.curvedGeometry = {
      circularCount: circularVoidCount,
      horseshoeCount: horseshoeVoidCount,
      curvedShellCount,
      shellApproximation: curvedShellCount > 0 ? 'ARC_POLYGON' : 'RECTANGULAR',
      voidApproximation: 'POLYGON',
      note: curvedShellCount > 0
        ? `${curvedShellCount} shell pieces use arc polygon profiles (IfcArbitraryClosedProfileDef). Void interior uses polygon approximation.`
        : 'Structural shell pieces use rectangular approximation. Void interior uses polygon approximation.'
    };
  }

  console.log(`Tunnel shell decomposition: ${decomposedBranchCount} branches → ${derivedShellPieceCount} shell pieces | Equipment containment: ${infrastructureLinkedCount} linked to ${voidSpaces.length} eligible void spaces (${noVoidAvailableCount} unmatched, ${invalidVoidCandidateCount} invalid void candidates)`);
}


// ============================================================================
// PHASE 1A: TUNNEL SHELL CONTINUITY ALIGNMENT
// Aligns adjacent shell pieces across branches without destroying semantics.
// Preserves: element_key, derivedFromBranch, shellPiece, assemblies, boundaries.
// Only micro-adjusts placement.origin and profile dimensions for zero-gap continuity.
// ============================================================================

function alignShellContinuity(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  // Build adjacency from TUNNEL_SEGMENT entry/exit nodes
  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  const shellPieces = css.elements.filter(e => e.properties?.shellPiece && e.properties?.derivedFromBranch);

  // Map: node → [parentKey, ...]
  const nodeToParents = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  // Find adjacent pairs: branches sharing a node with exactly degree 2 (no junctions)
  const adjacentPairs = new Set();
  for (const [node, parents] of Object.entries(nodeToParents)) {
    if (parents.length === 2) {
      const sorted = [parents[0], parents[1]].sort();
      adjacentPairs.add(`${sorted[0]}||${sorted[1]}`);
    }
  }

  if (adjacentPairs.size === 0) {
    console.log('alignShellContinuity: no adjacent branch pairs found');
    return;
  }

  // Group shell pieces by derivedFromBranch + shellPiece role
  const shellByBranchRole = {};
  for (const sp of shellPieces) {
    const branch = sp.properties.derivedFromBranch;
    const role = sp.properties.shellPiece;
    const key = `${branch}__${role}`;
    shellByBranchRole[key] = sp;
  }

  let alignedPairs = 0;
  let dimensionSnaps = 0;
  let continuityGroupCounter = 0;
  const continuityGroups = {}; // groupId -> [element_key, ...]

  const SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF', 'VOID'];
  const AXIS_DOT_MIN = 0.996; // ~5 degrees
  const DIM_TOLERANCE = 0.15; // 15%

  for (const pairKey of adjacentPairs) {
    const [branchA, branchB] = pairKey.split('||');

    for (const role of SHELL_ROLES) {
      const pieceA = shellByBranchRole[`${branchA}__${role}`];
      const pieceB = shellByBranchRole[`${branchB}__${role}`];
      if (!pieceA || !pieceB) continue;

      const axisA = vecNormalize(pieceA.placement?.axis);
      const axisB = vecNormalize(pieceB.placement?.axis);
      if (!axisA || !axisB) continue;

      // Check axis alignment (within 5 degrees)
      const dot = Math.abs(vecDot(axisA, axisB));
      if (dot < AXIS_DOT_MIN) continue;

      // Check cross-section similarity (within 15%)
      const wA = pieceA.geometry?.profile?.width || 0;
      const hA = pieceA.geometry?.profile?.height || 0;
      const wB = pieceB.geometry?.profile?.width || 0;
      const hB = pieceB.geometry?.profile?.height || 0;
      if (wA > 0 && wB > 0 && Math.abs(wA - wB) / Math.max(wA, wB) > DIM_TOLERANCE) continue;
      if (hA > 0 && hB > 0 && Math.abs(hA - hB) / Math.max(hA, hB) > DIM_TOLERANCE) continue;

      // Snap cross-section dimensions to average
      if (wA > 0 && wB > 0 && wA !== wB) {
        const avgW = (wA + wB) / 2;
        pieceA.geometry.profile.width = avgW;
        pieceB.geometry.profile.width = avgW;
        dimensionSnaps++;
      }
      if (hA > 0 && hB > 0 && hA !== hB) {
        const avgH = (hA + hB) / 2;
        pieceA.geometry.profile.height = avgH;
        pieceB.geometry.profile.height = avgH;
        dimensionSnaps++;
      }

      // Snap endpoints to eliminate micro-gaps
      // Piece endpoint = origin + axis * depth/2
      // Piece startpoint = origin - axis * depth/2
      const depthA = pieceA.geometry?.depth || 0;
      const depthB = pieceB.geometry?.depth || 0;
      if (depthA <= 0 || depthB <= 0) continue;

      const oA = pieceA.placement.origin;
      const oB = pieceB.placement.origin;

      // Find which ends are closest (A_end to B_start or A_start to B_end)
      const endA = vecAdd(oA, vecScale(axisA, depthA / 2));
      const startA = vecAdd(oA, vecScale(axisA, -depthA / 2));
      const endB = vecAdd(oB, vecScale(axisB, depthB / 2));
      const startB = vecAdd(oB, vecScale(axisB, -depthB / 2));

      const dEndAStartB = Math.sqrt((endA.x - startB.x) ** 2 + (endA.y - startB.y) ** 2 + (endA.z - startB.z) ** 2);
      const dStartAEndB = Math.sqrt((startA.x - endB.x) ** 2 + (startA.y - endB.y) ** 2 + (startA.z - endB.z) ** 2);

      // Only snap if gap is small (< 0.5m)
      const minGap = Math.min(dEndAStartB, dStartAEndB);
      if (minGap > 0.5) continue;

      if (dEndAStartB <= dStartAEndB && dEndAStartB > 0.001) {
        // Snap endA → startB: shift both origins slightly
        const mid = { x: (endA.x + startB.x) / 2, y: (endA.y + startB.y) / 2, z: (endA.z + startB.z) / 2 };
        // New origin A: mid - axis * depthA/2
        pieceA.placement.origin = vecAdd(mid, vecScale(axisA, -depthA / 2));
        // New origin B: mid + axis * depthB/2
        pieceB.placement.origin = vecAdd(mid, vecScale(axisB, depthB / 2));
      } else if (dStartAEndB > 0.001) {
        const mid = { x: (startA.x + endB.x) / 2, y: (startA.y + endB.y) / 2, z: (startA.z + endB.z) / 2 };
        pieceA.placement.origin = vecAdd(mid, vecScale(axisA, depthA / 2));
        pieceB.placement.origin = vecAdd(mid, vecScale(axisB, -depthB / 2));
      }

      // Assign continuity group
      const existingGroupA = pieceA.properties.continuityGroupId;
      const existingGroupB = pieceB.properties.continuityGroupId;
      let groupId;
      if (existingGroupA) { groupId = existingGroupA; }
      else if (existingGroupB) { groupId = existingGroupB; }
      else { groupId = `cg-${role.toLowerCase()}-${continuityGroupCounter++}`; }

      pieceA.properties.continuityGroupId = groupId;
      pieceB.properties.continuityGroupId = groupId;
      if (!pieceA.properties.adjacentShellKeys) pieceA.properties.adjacentShellKeys = [];
      if (!pieceB.properties.adjacentShellKeys) pieceB.properties.adjacentShellKeys = [];
      if (!pieceA.properties.adjacentShellKeys.includes(pieceB.element_key)) pieceA.properties.adjacentShellKeys.push(pieceB.element_key);
      if (!pieceB.properties.adjacentShellKeys.includes(pieceA.element_key)) pieceB.properties.adjacentShellKeys.push(pieceA.element_key);

      if (!continuityGroups[groupId]) continuityGroups[groupId] = new Set();
      continuityGroups[groupId].add(pieceA.element_key);
      continuityGroups[groupId].add(pieceB.element_key);

      alignedPairs++;
    }
  }

  // Phase 3D: Dimension averaging at degree-3+ nodes (no endpoint snapping — too complex for multi-branch)
  let junctionDimSnaps = 0;
  const junctionNodes = [];
  for (const [node, parents] of Object.entries(nodeToParents)) {
    if (parents.length < 3) continue;
    junctionNodes.push(node);

    for (const role of SHELL_ROLES) {
      const piecesAtNode = parents.map(p => shellByBranchRole[`${p}__${role}`]).filter(Boolean);
      if (piecesAtNode.length < 2) continue;

      // Average width and height across all pieces at this junction
      const widths = piecesAtNode.map(p => p.geometry?.profile?.width).filter(w => w > 0);
      const heights = piecesAtNode.map(p => p.geometry?.profile?.height).filter(h => h > 0);
      if (widths.length >= 2) {
        const avgW = widths.reduce((s, w) => s + w, 0) / widths.length;
        for (const p of piecesAtNode) {
          if (p.geometry?.profile?.width > 0 && Math.abs(p.geometry.profile.width - avgW) / avgW < DIM_TOLERANCE) {
            p.geometry.profile.width = avgW;
            junctionDimSnaps++;
          }
        }
      }
      if (heights.length >= 2) {
        const avgH = heights.reduce((s, h) => s + h, 0) / heights.length;
        for (const p of piecesAtNode) {
          if (p.geometry?.profile?.height > 0 && Math.abs(p.geometry.profile.height - avgH) / avgH < DIM_TOLERANCE) {
            p.geometry.profile.height = avgH;
            junctionDimSnaps++;
          }
        }
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.shellContinuity = {
    adjacentBranchPairs: adjacentPairs.size,
    alignedShellPairs: alignedPairs,
    dimensionSnaps,
    junctionDimSnaps,
    junctionNodes: junctionNodes.length,
    continuityGroups: Object.keys(continuityGroups).length,
    sampleGroups: Object.entries(continuityGroups).slice(0, 3).map(([id, keys]) => ({ id, members: keys.size }))
  };

  console.log(`alignShellContinuity: ${alignedPairs} shell pairs aligned across ${adjacentPairs.size} branch pairs, ${Object.keys(continuityGroups).length} continuity groups, ${dimensionSnaps} dimension snaps, ${junctionDimSnaps} junction dimension snaps at ${junctionNodes.length} junction nodes`);
}


// ============================================================================
// PHASE 3A: SHELL EXTENSION AT JUNCTIONS
// Extends shell pieces at junction/bend nodes to reduce gaps.
// ============================================================================

function extendShellAtJunctions(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  const shellPieces = css.elements.filter(e => e.properties?.shellPiece && e.properties?.derivedFromBranch);

  // Build node adjacency
  const nodeToParents = {};
  const segByKey = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    segByKey[key] = seg;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  // Shell pieces by branch
  const shellByBranch = {};
  for (const sp of shellPieces) {
    const branch = sp.properties.derivedFromBranch;
    if (!shellByBranch[branch]) shellByBranch[branch] = [];
    shellByBranch[branch].push(sp);
  }

  let extensionCount = 0;
  const extendedNodes = [];

  for (const [node, parents] of Object.entries(nodeToParents)) {
    const degree = parents.length;
    if (degree < 2) continue;

    // For degree-2: check angle between axes
    let shouldExtend = degree >= 3;
    if (degree === 2) {
      const segA = segByKey[parents[0]];
      const segB = segByKey[parents[1]];
      if (segA && segB) {
        const axA = vecNormalize(segA.placement?.axis);
        const axB = vecNormalize(segB.placement?.axis);
        if (axA && axB) {
          const dot = Math.abs(vecDot(axA, axB));
          // angle > 20° means dot < cos(20°) ≈ 0.94
          if (dot < 0.94) shouldExtend = true;
        }
      }
    }
    if (!shouldExtend) continue;

    // Extend shell pieces from each branch at this node
    for (const parentKey of parents) {
      const seg = segByKey[parentKey];
      if (!seg) continue;
      const pieces = shellByBranch[parentKey];
      if (!pieces || pieces.length === 0) continue;

      // Determine which end of the segment faces this node
      const isEntryEnd = seg.properties?.entry_node === node;
      const segAxis = vecNormalize(seg.placement?.axis);
      if (!segAxis) continue;

      for (const piece of pieces) {
        const depth = piece.geometry?.depth;
        if (!depth || depth <= 0) continue;

        const EXTENSION = Math.min(0.5, depth * 0.1);
        if (EXTENSION < 0.01) continue;

        // Extend depth
        piece.geometry.depth = depth + EXTENSION;

        // Shift origin so the far end stays fixed
        // If entry_node is at this junction, the entry end is at origin - axis*depth/2
        // We want to extend that end: shift origin toward junction by EXTENSION/2
        const shift = isEntryEnd ? -EXTENSION / 2 : EXTENSION / 2;
        const pieceAxis = vecNormalize(piece.placement?.axis);
        if (pieceAxis && piece.placement?.origin) {
          piece.placement.origin = vecAdd(piece.placement.origin, vecScale(pieceAxis, shift));
        }

        if (!piece.properties) piece.properties = {};
        piece.properties.junctionExtended = true;
        extensionCount++;
      }
    }
    extendedNodes.push(node);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.junctionExtensions = { count: extensionCount, nodes: extendedNodes };
  if (extensionCount > 0) {
    console.log(`extendShellAtJunctions: ${extensionCount} shell pieces extended at ${extendedNodes.length} nodes`);
  }
}


// ============================================================================
// PHASE 3B: JUNCTION TRANSITION HELPER VOLUMES
// Generates 1-2 approximation geometry elements per junction to fill gaps.
// Uses PROXY type — NOT canonical structure.
// ============================================================================

function generateJunctionTransitions(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const WALL_THICKNESS = 0.3;
  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  const shellPieces = css.elements.filter(e => e.properties?.shellPiece && e.properties?.derivedFromBranch);

  // Build node adjacency
  const nodeToParents = {};
  const segByKey = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    segByKey[key] = seg;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  // Shell pieces by branch (for checking voids)
  const voidByBranch = {};
  for (const sp of shellPieces) {
    if (sp.properties?.shellPiece === 'VOID') {
      voidByBranch[sp.properties.derivedFromBranch] = sp;
    }
  }

  const transitionElements = [];
  let junctionCount = 0;
  let bendCount = 0;
  let voidHelpersGenerated = 0;

  for (const [node, parents] of Object.entries(nodeToParents)) {
    const degree = parents.length;
    if (degree < 2) continue;

    // Collect branch endpoints at this node
    const branchEndpoints = [];
    for (const parentKey of parents) {
      const seg = segByKey[parentKey];
      if (!seg?.placement?.origin || !seg?.placement?.axis) continue;
      const ax = vecNormalize(seg.placement.axis);
      if (!ax) continue;
      const depth = seg.geometry?.depth || 0;
      const W = seg.geometry?.profile?.width || 4;
      const H = seg.geometry?.profile?.height || 4;

      // Determine which endpoint is at this node
      const isEntry = seg.properties?.entry_node === node;
      const endOffset = isEntry ? -depth / 2 : depth / 2;
      const endpoint = vecAdd(seg.placement.origin, vecScale(ax, endOffset));

      branchEndpoints.push({ key: parentKey, endpoint, axis: ax, W, H, depth, container: seg.container, isEntry });
    }

    if (branchEndpoints.length < 2) continue;

    // For degree-2: check angle for bend transition
    if (degree === 2) {
      const axA = branchEndpoints[0].axis;
      const axB = branchEndpoints[1].axis;
      const dot = Math.abs(vecDot(axA, axB));
      // angle > 30° means dot < cos(30°) ≈ 0.866
      if (dot >= 0.866) continue;

      // Generate bend plug
      const center = {
        x: (branchEndpoints[0].endpoint.x + branchEndpoints[1].endpoint.x) / 2,
        y: (branchEndpoints[0].endpoint.y + branchEndpoints[1].endpoint.y) / 2,
        z: (branchEndpoints[0].endpoint.z + branchEndpoints[1].endpoint.z) / 2
      };
      const bisector = vecNormalize(vecAdd(axA, axB));
      const bendAxis = bisector || axA;
      const jW = Math.max(branchEndpoints[0].W, branchEndpoints[1].W);
      const jH = Math.max(branchEndpoints[0].H, branchEndpoints[1].H);
      // Adaptive depth: cover the gap between endpoints, with 20% margin, capped at 2m
      const gapDist = vecDist(branchEndpoints[0].endpoint, branchEndpoints[1].endpoint);
      const bendPlugDepth = Math.max(0.5, Math.min(gapDist * 1.2, 2.0));

      transitionElements.push({
        id: `bend-plug-${node}`,
        element_key: `bend-plug-${node}`,
        type: 'PROXY',
        name: `Bend Transition — ${node}`,
        semanticType: 'IfcBuildingElementProxy',
        confidence: 0.2,
        source: 'TRANSITION_APPROXIMATION',
        container: branchEndpoints[0].container,
        placement: {
          origin: center,
          axis: bendAxis,
          refDirection: vecNormalize(vecCross(bendAxis, { x: 0, y: 0, z: 1 })) || { x: 1, y: 0, z: 0 }
        },
        geometry: {
          method: 'EXTRUSION',
          direction: { x: 0, y: 0, z: 1 },
          depth: bendPlugDepth,
          profile: { type: 'RECTANGLE', width: jW, height: jH }
        },
        material: { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 },
        properties: { isBendTransition: true, isTransitionHelper: true, geometryApproximation: 'BEND_PLUG', bendNodeId: node, gapDistance: +gapDist.toFixed(3) },
        relationships: []
      });
      bendCount++;
      continue;
    }

    // Degree ≥ 3: junction transition plug
    junctionCount++;

    // Compute junction center
    const center = {
      x: branchEndpoints.reduce((s, b) => s + b.endpoint.x, 0) / branchEndpoints.length,
      y: branchEndpoints.reduce((s, b) => s + b.endpoint.y, 0) / branchEndpoints.length,
      z: branchEndpoints.reduce((s, b) => s + b.endpoint.z, 0) / branchEndpoints.length
    };

    const jW = Math.max(...branchEndpoints.map(b => b.W));
    const jH = Math.max(...branchEndpoints.map(b => b.H));
    const maxDepth = Math.max(...branchEndpoints.map(b => b.depth));
    // Compute max gap from center to any branch endpoint BEFORE plug depth calculation
    const maxGap = Math.max(...branchEndpoints.map(b => vecDist(b.endpoint, center)));
    // Adaptive depth: max of proportional rule and 2*maxGap (to span from center to furthest endpoint), capped at 3m
    const plugDepth = Math.max(Math.min(1.0, 0.15 * maxDepth), Math.min(2 * maxGap, 3.0));

    // Weighted average axis
    const avgAxis = vecNormalize(branchEndpoints.reduce((acc, b) => vecAdd(acc, b.axis), { x: 0, y: 0, z: 0 }));
    const junctionAxis = avgAxis || { x: 1, y: 0, z: 0 };

    const plugElem = {
      id: `junction-plug-${node}`,
      element_key: `junction-plug-${node}`,
      type: 'PROXY',
      name: `Junction Transition — ${node}`,
      semanticType: 'IfcBuildingElementProxy',
      confidence: 0.25,
      source: 'TRANSITION_APPROXIMATION',
      container: branchEndpoints[0].container,
      placement: {
        origin: center,
        axis: junctionAxis,
        refDirection: vecNormalize(vecCross(junctionAxis, { x: 0, y: 0, z: 1 })) || { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: plugDepth,
        profile: { type: 'RECTANGLE', width: jW, height: jH }
      },
      material: { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 },
      properties: {
        isTransitionHelper: true,
        junctionNodeId: node,
        junctionDegree: degree,
        geometryApproximation: 'JUNCTION_PLUG',
        maxGapDistance: +maxGap.toFixed(3)
      },
      relationships: []
    };
    transitionElements.push(plugElem);

    // Conditionally generate companion void
    const hasVoids = branchEndpoints.some(b => !!voidByBranch[b.key]);
    const needsVoid = hasVoids || maxGap > 0.5;

    if (needsVoid) {
      const innerW = jW - 2 * WALL_THICKNESS;
      const innerH = jH - 2 * WALL_THICKNESS;
      if (innerW > 0.1 && innerH > 0.1) {
        transitionElements.push({
          id: `junction-void-${node}`,
          element_key: `junction-void-${node}`,
          type: 'SPACE',
          name: `Junction Void — ${node}`,
          semanticType: 'IfcSpace',
          confidence: 0.2,
          source: 'TRANSITION_APPROXIMATION',
          container: branchEndpoints[0].container,
          placement: { ...plugElem.placement, origin: { ...center } },
          geometry: {
            method: 'EXTRUSION',
            direction: { x: 0, y: 0, z: 1 },
            depth: plugDepth,
            profile: { type: 'RECTANGLE', width: innerW, height: innerH }
          },
          material: { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 },
          properties: { isTransitionHelper: true, shellPiece: 'VOID', junctionNodeId: node },
          relationships: []
        });
        voidHelpersGenerated++;
      }
    }
  }

  if (transitionElements.length > 0) {
    css.elements.push(...transitionElements);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.junctionTransitions = {
    junctionCount,
    bendCount,
    transitionElementCount: transitionElements.length,
    voidHelpersGenerated
  };
  if (transitionElements.length > 0) {
    console.log(`generateJunctionTransitions: ${junctionCount} junctions, ${bendCount} bends → ${transitionElements.length} transition elements (${voidHelpersGenerated} void helpers)`);
  }
}


// ============================================================================
// PHASE 3: EQUIPMENT MOUNTING (Universal — domain-aware)
// Deterministic placement corrections so equipment appears physically installed.
// ============================================================================

function applyEquipmentMounting(css) {
  if (!css.elements || css.elements.length === 0) return;

  const isTunnel = (css.domain || '').toUpperCase() === 'TUNNEL';

  // Mounting type by semantic type
  const WALL_MOUNTED = new Set(['IfcSensor', 'IfcAlarm', 'IfcActuator', 'IfcCommunicationsAppliance',
    'IfcElectricDistributionBoard', 'IfcFireSuppressionTerminal']);
  const CEILING_MOUNTED = new Set(['IfcLightFixture', 'IfcFan', 'IfcCableCarrierSegment']);
  const FLOOR_MOUNTED = new Set(['IfcPump', 'IfcTank', 'IfcTransformer', 'IfcBoiler', 'IfcChiller',
    'IfcCompressor', 'IfcElectricGenerator']);

  // Build spatial context
  // For tunnels: collect void spaces with their geometry
  const voidSpaces = {};
  if (isTunnel) {
    for (const e of css.elements) {
      if (e.properties?.shellPiece === 'VOID' && e.placement?.origin) {
        const branch = e.properties.derivedFromBranch;
        if (branch) {
          voidSpaces[branch] = {
            origin: e.placement.origin,
            width: (e.geometry?.profile?.width || 4) - 0.1,
            height: (e.geometry?.profile?.height || 4) - 0.1,
            depth: e.geometry?.depth || 10
          };
        }
      }
    }
  }

  // For buildings: get storey elevations and heights
  const storeyInfo = {};
  if (!isTunnel) {
    const levels = css.levelsOrSegments || [];
    for (let i = 0; i < levels.length; i++) {
      const elev = levels[i].elevation_m || 0;
      const height = levels[i].height_m || 3.0;
      storeyInfo[levels[i].id] = { elevation: elev, height };
    }
  }

  let mountingCorrections = 0;
  let originGuardCorrections = 0;
  const STANDOFF = 0.05;

  for (const elem of css.elements) {
    if (elem.type !== 'EQUIPMENT') continue;
    const st = elem.semanticType || '';
    const o = elem.placement?.origin;
    if (!o) continue;

    // Origin guard: equipment at exactly (0,0,0) is almost certainly unplaced
    if (Math.abs(o.x) < 0.001 && Math.abs(o.y) < 0.001 && Math.abs(o.z) < 0.001) {
      // Find nearest space center
      let bestCenter = null;
      let bestDist = Infinity;
      if (isTunnel) {
        for (const vs of Object.values(voidSpaces)) {
          bestCenter = vs.origin;
          break; // just use first available
        }
      } else {
        // For buildings: use first storey center from bbox
        const bbox = css.metadata?.bbox;
        if (bbox) {
          bestCenter = {
            x: (bbox.min.x + bbox.max.x) / 2,
            y: (bbox.min.y + bbox.max.y) / 2,
            z: bbox.min.z + 1.0
          };
        }
      }
      if (bestCenter) {
        if (!elem.metadata) elem.metadata = {};
        elem.metadata.originalPlacement = { ...o };
        elem.metadata.originError = true;
        elem.placement.origin = { ...bestCenter };
        originGuardCorrections++;
      }
      continue;
    }

    // Determine mounting type
    let mountType = 'NONE';
    if (WALL_MOUNTED.has(st)) mountType = 'WALL';
    else if (CEILING_MOUNTED.has(st)) mountType = 'CEILING';
    else if (FLOOR_MOUNTED.has(st)) mountType = 'FLOOR';
    if (mountType === 'NONE') continue;

    // Save original
    if (!elem.metadata) elem.metadata = {};
    elem.metadata.originalPlacement = { ...o };

    const eqHeight = elem.geometry?.profile?.height || elem.geometry?.depth || 0.5;

    if (isTunnel) {
      // Use matched void space
      const matchedBranch = elem.properties?.hostStructuralBranchMatched || elem.properties?.derivedFromBranch;
      const vs = matchedBranch ? voidSpaces[matchedBranch] : Object.values(voidSpaces)[0];
      if (!vs) continue;

      const halfH = vs.height / 2;
      const floorZ = vs.origin.z - halfH;
      const ceilZ = vs.origin.z + halfH;

      if (mountType === 'FLOOR') {
        o.z = floorZ + STANDOFF;
        mountingCorrections++;
      } else if (mountType === 'CEILING') {
        o.z = ceilZ - eqHeight - STANDOFF;
        mountingCorrections++;
      } else if (mountType === 'WALL') {
        // Clamp z to mid-height of void (wall-mounted typically at ~1.5m above floor)
        o.z = floorZ + Math.min(1.5, halfH);
        mountingCorrections++;
      }
    } else {
      // Building: use storey info
      const container = elem.container || 'level-1';
      const si = storeyInfo[container] || { elevation: 0, height: 3.0 };

      if (mountType === 'FLOOR') {
        o.z = si.elevation + STANDOFF;
        mountingCorrections++;
      } else if (mountType === 'CEILING') {
        o.z = si.elevation + si.height - eqHeight - STANDOFF;
        mountingCorrections++;
      } else if (mountType === 'WALL') {
        o.z = si.elevation + Math.min(1.5, si.height * 0.5);
        mountingCorrections++;
      }
    }

    elem.metadata.mountingType = mountType;
    elem.metadata.correctedBy = 'EQUIPMENT_MOUNTING';
    elem.metadata.correctionDelta = {
      dx: Math.round((o.x - elem.metadata.originalPlacement.x) * 100) / 100,
      dy: Math.round((o.y - elem.metadata.originalPlacement.y) * 100) / 100,
      dz: Math.round((o.z - elem.metadata.originalPlacement.z) * 100) / 100
    };
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.equipmentMounting = { mountingCorrections, originGuardCorrections };
  console.log(`applyEquipmentMounting: ${mountingCorrections} mounting corrections, ${originGuardCorrections} origin guard corrections`);
}


// ============================================================================
// PHASE 2: BUILDING ENVELOPE GUARANTEE (domain: non-TUNNEL)
// Ensures coherent rectangular envelope when extraction is weak.
// ============================================================================

function guaranteeBuildingEnvelope(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const floorSlabs = css.elements.filter(e => (e.type || '').toUpperCase() === 'SLAB' && (e.properties?.slabType || '').toUpperCase() === 'FLOOR');
  const roofSlabs = css.elements.filter(e => (e.type || '').toUpperCase() === 'SLAB' && (e.properties?.slabType || '').toUpperCase() === 'ROOF');
  const allSlabs = css.elements.filter(e => (e.type || '').toUpperCase() === 'SLAB');

  // Compute bounding box from all elements
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const e of css.elements) {
    const o = e.placement?.origin;
    if (!o) continue;
    if (o.x < minX) minX = o.x; if (o.x > maxX) maxX = o.x;
    if (o.y < minY) minY = o.y; if (o.y > maxY) maxY = o.y;
    if (o.z < minZ) minZ = o.z; if (o.z > maxZ) maxZ = o.z;
  }

  if (!isFinite(minX)) return; // no valid placements

  // Get storey height or default
  const firstLevel = (css.levelsOrSegments || [])[0];
  const storeyHeight = firstLevel?.height_m || 3.0;
  const container = firstLevel?.id || 'level-1';

  // Ensure reasonable bbox dimensions
  const bboxW = Math.max(maxX - minX, 3.0);
  const bboxD = Math.max(maxY - minY, 3.0);

  const generated = [];
  let fallbackApplied = false;

  // Generate walls if fewer than 4
  if (walls.length < 4) {
    fallbackApplied = true;
    const wallThickness = 0.25;
    const wallHeight = storeyHeight;

    // 4 envelope walls: North, South, East, West
    const wallDefs = [
      { name: 'North Wall', ox: (minX + maxX) / 2, oy: maxY, dirX: 1, dirY: 0, len: bboxW },
      { name: 'South Wall', ox: (minX + maxX) / 2, oy: minY, dirX: 1, dirY: 0, len: bboxW },
      { name: 'East Wall', ox: maxX, oy: (minY + maxY) / 2, dirX: 0, dirY: 1, len: bboxD },
      { name: 'West Wall', ox: minX, oy: (minY + maxY) / 2, dirX: 0, dirY: 1, len: bboxD },
    ];

    for (const wd of wallDefs) {
      const wallElem = {
        id: `env-wall-${wd.name.toLowerCase().replace(/\s/g, '-')}`,
        element_key: `env-wall-${wd.name.toLowerCase().replace(/\s/g, '-')}`,
        type: 'WALL',
        name: wd.name,
        semanticType: 'IfcWall',
        confidence: 0.4,
        source: 'ENVELOPE_FALLBACK',
        container,
        placement: {
          origin: { x: wd.ox, y: wd.oy, z: minZ },
          axis: { x: 0, y: 0, z: 1 },                          // local Z = up (extrusion direction)
          refDirection: { x: wd.dirX, y: wd.dirY, z: 0 }       // local X = wall run direction
        },
        geometry: {
          method: 'EXTRUSION',
          direction: { x: 0, y: 0, z: 1 },
          depth: wallHeight,
          profile: { type: 'RECTANGLE', width: wd.len, height: wallThickness }
        },
        material: { name: 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 },
        properties: { isExternal: true, isFallback: true },
        relationships: []
      };
      generated.push(wallElem);
    }
  }

  // Generate floor slab if missing
  if (floorSlabs.length === 0 && allSlabs.filter(s => !s.properties?.slabType || s.properties.slabType === 'FLOOR').length === 0) {
    fallbackApplied = true;
    generated.push({
      id: 'env-floor-slab',
      element_key: 'env-floor-slab',
      type: 'SLAB',
      name: 'Floor Slab',
      semanticType: 'IfcSlab',
      confidence: 0.4,
      source: 'ENVELOPE_FALLBACK',
      container,
      placement: {
        origin: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: minZ },
        axis: { x: 0, y: 0, z: 1 },             // local Z = up (extrusion direction)
        refDirection: { x: 1, y: 0, z: 0 }       // local X = length direction
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: 0.2,
        profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
      },
      material: { name: 'concrete_floor', color: [0.65, 0.65, 0.65], transparency: 0 },
      properties: { slabType: 'FLOOR', isFallback: true },
      relationships: []
    });
  }

  // Generate roof slab if missing
  if (roofSlabs.length === 0 && allSlabs.filter(s => (s.properties?.slabType || '').toUpperCase() === 'ROOF').length === 0) {
    fallbackApplied = true;
    generated.push({
      id: 'env-roof-slab',
      element_key: 'env-roof-slab',
      type: 'SLAB',
      name: 'Roof Slab',
      semanticType: 'IfcSlab',
      confidence: 0.4,
      source: 'ENVELOPE_FALLBACK',
      container,
      placement: {
        origin: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: minZ + storeyHeight },
        axis: { x: 0, y: 0, z: 1 },             // local Z = up (extrusion direction)
        refDirection: { x: 1, y: 0, z: 0 }       // local X = length direction
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: 0.2,
        profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
      },
      material: { name: 'metal_roof', color: [0.4, 0.45, 0.5], transparency: 0 },
      properties: { slabType: 'ROOF', isFallback: true },
      relationships: []
    });
  }

  if (generated.length > 0) {
    css.elements.push(...generated);
    if (!css.metadata) css.metadata = {};
    css.metadata.envelopeFallbackApplied = true;
    css.metadata.envelopeFallback = {
      generatedWalls: generated.filter(e => e.type === 'WALL').length,
      generatedSlabs: generated.filter(e => e.type === 'SLAB').length,
      originalWalls: walls.length,
      originalSlabs: allSlabs.length,
      bboxUsed: { minX, maxX, minY, maxY, minZ, maxZ, bboxW, bboxD }
    };
    console.log(`guaranteeBuildingEnvelope: generated ${generated.length} fallback elements (${generated.filter(e => e.type === 'WALL').length} walls, ${generated.filter(e => e.type === 'SLAB').length} slabs)`);
  }
}


// ============================================================================
// PHASE 4A: OPENING PLACEMENT VALIDATION (non-TUNNEL)
// Conservative: wrong visible geometry is worse than missing geometry.
// ============================================================================

function validateOpeningPlacement(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') return;

  const openingTypes = new Set(['DOOR', 'WINDOW', 'OPENING']);
  const openings = css.elements.filter(e => openingTypes.has((e.type || '').toUpperCase()));
  if (openings.length === 0) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  if (walls.length === 0) return;

  let valid = 0, rehosted = 0, downgraded = 0;
  const unresolvedOpenings = [];
  const removeKeys = new Set();

  for (const opening of openings) {
    const oo = opening.placement?.origin;
    if (!oo) { valid++; continue; }

    // Find host wall
    let hostWall = null;
    const hostKey = opening.properties?.hostWallKey;
    if (hostKey) {
      hostWall = walls.find(w => (w.element_key || w.id) === hostKey);
    }
    if (!hostWall) {
      // Find nearest wall within 2m
      let bestDist = Infinity;
      for (const w of walls) {
        const wo = w.placement?.origin;
        if (!wo) continue;
        const d = vecDist(oo, wo);
        if (d < bestDist) { bestDist = d; hostWall = w; }
      }
      if (bestDist > 2.0) hostWall = null;
    }

    if (!hostWall) {
      // No host — downgrade
      unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'no_host_wall' });
      removeKeys.add(opening.element_key || opening.id);
      downgraded++;
      continue;
    }

    // Check if opening is within host wall bounds (±0.3m tolerance)
    const wo = hostWall.placement?.origin;
    if (!wo) { valid++; continue; }

    const wW = hostWall.geometry?.profile?.width || 1;
    const wH = hostWall.geometry?.profile?.height || 0.25;
    const wD = hostWall.geometry?.depth || 3;
    const tolerance = 0.3;

    const dist = vecDist(oo, wo);
    const isOutside = dist > (Math.max(wW, wD) / 2 + tolerance);

    if (isOutside) {
      const confidence = opening.confidence || 0.5;
      if (confidence >= 0.6) {
        // Try rehosting to nearest wall within 0.5m
        let bestRehost = null;
        let bestRehostDist = 0.5;
        for (const w of walls) {
          if (w === hostWall) continue;
          const d = vecDist(oo, w.placement?.origin || { x: 0, y: 0, z: 0 });
          if (d < bestRehostDist) { bestRehostDist = d; bestRehost = w; }
        }
        if (bestRehost) {
          if (!opening.properties) opening.properties = {};
          opening.properties.rehosted = true;
          opening.properties.originalHostWall = hostKey || (hostWall.element_key || hostWall.id);
          opening.properties.hostWallKey = bestRehost.element_key || bestRehost.id;
          rehosted++;
        } else {
          unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'outside_bounds_no_rehost' });
          removeKeys.add(opening.element_key || opening.id);
          downgraded++;
        }
      } else {
        unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'outside_bounds_low_confidence' });
        removeKeys.add(opening.element_key || opening.id);
        downgraded++;
      }
    } else {
      valid++;
    }

    // Door floor-snap: z within 0.3m of floor level
    if ((opening.type || '').toUpperCase() === 'DOOR' && oo.z !== undefined) {
      const levels = css.levelsOrSegments || [];
      const container = opening.container;
      const level = levels.find(l => l.id === container);
      const floorZ = level?.elevation_m || 0;
      if (Math.abs(oo.z - floorZ) < 0.3) {
        oo.z = floorZ;
      }
    }
  }

  // Remove downgraded openings from elements
  if (removeKeys.size > 0) {
    css.elements = css.elements.filter(e => !removeKeys.has(e.element_key || e.id));
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.openingValidation = { total: openings.length, valid, rehosted, downgraded };
  if (unresolvedOpenings.length > 0) {
    css.metadata.unresolvedOpenings = unresolvedOpenings;
  }
  console.log(`validateOpeningPlacement: ${openings.length} total, ${valid} valid, ${rehosted} rehosted, ${downgraded} downgraded`);
}


// ============================================================================
// PHASE 4B: WALL AXIS CLEANUP (non-TUNNEL)
// Groups walls by direction and aligns. 10° angular cap + 0.3m positional cap.
// ============================================================================

function cleanBuildingWallAxes(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() === 'TUNNEL') return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  if (walls.length < 2) return;

  const ANGLE_CAP = 10 * Math.PI / 180; // 10°
  const POSITION_CAP = 0.3; // 0.3m max movement
  const LINE_OFFSET_TOL = 0.2; // 0.2m for collinear detection

  // Infer wall run direction: prefer refDirection > wallSide > horizontal axis
  function inferWallDir(wall) {
    // Prefer refDirection — this is the wall run direction (horizontal)
    const ref = wall.placement?.refDirection;
    if (ref) {
      const d = vecNormalize(ref);
      if (d) return d;
    }
    // Fallback: infer from wallSide property
    const side = wall.properties?.wallSide;
    if (side === 'SOUTH' || side === 'NORTH') return { x: 1, y: 0, z: 0 };
    if (side === 'EAST' || side === 'WEST') return { x: 0, y: 1, z: 0 };
    // Last fallback: placement.axis only if clearly horizontal (not Z-up)
    const ax = wall.placement?.axis;
    if (ax) {
      const n = vecNormalize(ax);
      if (n && Math.abs(n.z || 0) < 0.5) return n;
    }
    return null;
  }

  // Group by approximate direction
  const groups = [];
  for (const wall of walls) {
    const dir = inferWallDir(wall);
    if (!dir) continue;

    let placed = false;
    for (const group of groups) {
      const dot = Math.abs(vecDot(dir, group.avgDir));
      if (dot > Math.cos(ANGLE_CAP)) {
        group.walls.push(wall);
        group.dirs.push(dir);
        // Update average direction
        const sum = group.dirs.reduce((acc, d) => vecAdd(acc, d), { x: 0, y: 0, z: 0 });
        group.avgDir = vecNormalize(sum) || group.avgDir;
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ avgDir: dir, dirs: [dir], walls: [wall] });
    }
  }

  let snappedCount = 0;
  let skippedOverCap = 0;

  for (const group of groups) {
    if (group.walls.length < 2) continue;
    const avgDir = group.avgDir;

    // Snap wall run direction to group average (with endpoint movement cap)
    for (const wall of group.walls) {
      const currentDir = inferWallDir(wall);
      if (!currentDir) continue;
      const dot = Math.abs(vecDot(currentDir, avgDir));
      if (dot >= 0.9998) continue; // already aligned

      // Check endpoint shift from direction change doesn't exceed POSITION_CAP
      const wallLen = getWallLength(wall);
      const origin = wall.placement?.origin;
      if (origin && wallLen > 0) {
        const oldEnd = vecAdd(origin, vecScale(currentDir, wallLen / 2));
        const newEnd = vecAdd(origin, vecScale(avgDir, wallLen / 2));
        const endpointShift = vecDist(oldEnd, newEnd);
        if (endpointShift > POSITION_CAP) {
          skippedOverCap++;
          continue; // don't snap — endpoint would move too far
        }
      }

      // Apply snap: update refDirection (preferred) or axis
      if (wall.placement?.refDirection) {
        wall.placement.refDirection = { ...avgDir };
      } else if (wall.placement?.axis) {
        wall.placement.axis = { ...avgDir };
      } else {
        if (!wall.placement) wall.placement = {};
        wall.placement.refDirection = { ...avgDir };
      }
      snappedCount++;
    }

    // Align nearly-collinear walls (parallel within LINE_OFFSET_TOL)
    for (let i = 0; i < group.walls.length; i++) {
      const wA = group.walls[i];
      const oA = wA.placement?.origin;
      if (!oA) continue;

      for (let j = i + 1; j < group.walls.length; j++) {
        const wB = group.walls[j];
        const oB = wB.placement?.origin;
        if (!oB) continue;

        // Compute perpendicular offset between wall lines
        const ab = vecSub(oB, oA);
        const proj = vecDot(ab, avgDir);
        const perp = vecSub(ab, vecScale(avgDir, proj));
        const perpDist = Math.sqrt(perp.x ** 2 + perp.y ** 2 + perp.z ** 2);

        if (perpDist > 0.001 && perpDist < LINE_OFFSET_TOL) {
          // Move B to A's line (half the offset each)
          const halfPerp = vecScale(perp, 0.5);
          const moveA = Math.sqrt(halfPerp.x ** 2 + halfPerp.y ** 2 + halfPerp.z ** 2);
          if (moveA > POSITION_CAP) {
            skippedOverCap++;
            continue;
          }
          wA.placement.origin = vecAdd(oA, halfPerp);
          wB.placement.origin = vecSub(oB, halfPerp);
          snappedCount += 2;
        }
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.wallAxisCleanup = { groupCount: groups.length, snappedCount, skippedOverCap };
  if (snappedCount > 0) {
    console.log(`cleanBuildingWallAxes: ${snappedCount} wall axis/position corrections across ${groups.length} groups (${skippedOverCap} skipped over 0.3m cap)`);
  }
}


// ============================================================================
// DIMENSION VALIDATION (Universal — all domains)
// Clamps absurd dimensions with logging.
// ============================================================================

function clampAbsurdDimensions(css) {
  if (!css.elements) return;

  const CLAMPS = {
    WALL: { minW: 0.05, maxW: 200, minH: 0.05, maxH: 2.0, minD: 0.5, maxD: 50 },
    SLAB: { minW: 0.5, maxW: 200, minH: 0.05, maxH: 3.0, minD: 0.05, maxD: 3.0 },
    SPACE: { minW: 0.5, maxW: 200, minH: 0.5, maxH: 200, minD: 0.5, maxD: 5000 },
    EQUIPMENT: { minW: 0.01, maxW: 20, minH: 0.01, maxH: 20, minD: 0.01, maxD: 20 },
    DEFAULT: { minW: 0.01, maxW: 500, minH: 0.01, maxH: 500, minD: 0.01, maxD: 5000 }
  };

  let clampCount = 0;

  for (const elem of css.elements) {
    const g = elem.geometry;
    if (!g) continue;
    const type = (elem.type || '').toUpperCase();
    const limits = CLAMPS[type] || CLAMPS.DEFAULT;

    const p = g.profile;
    if (p?.width !== undefined) {
      const orig = p.width;
      p.width = Math.max(limits.minW, Math.min(limits.maxW, p.width));
      if (p.width !== orig) { clampCount++; }
    }
    if (p?.height !== undefined) {
      const orig = p.height;
      p.height = Math.max(limits.minH, Math.min(limits.maxH, p.height));
      if (p.height !== orig) { clampCount++; }
    }
    if (g.depth !== undefined) {
      const orig = g.depth;
      g.depth = Math.max(limits.minD, Math.min(limits.maxD, g.depth));
      if (g.depth !== orig) { clampCount++; }
    }
  }

  if (clampCount > 0) {
    console.log(`clampAbsurdDimensions: ${clampCount} dimension clamps applied`);
    if (!css.metadata) css.metadata = {};
    css.metadata.dimensionClamps = clampCount;
  }
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

const AMBIGUOUS_RATIO_TOL = 1.15; // within 15% = ambiguous profile
let ambiguousProfileCount = 0;

function getDir(elem) {
  // Prefer refDirection (horizontal wall axis) over geometry.direction (extrusion = Z-up)
  const ref = elem.placement?.refDirection;
  if (ref) {
    const rx = ref.x ?? 0, ry = ref.y ?? 0, rz = ref.z ?? 0;
    const len = Math.sqrt(rx*rx + ry*ry + rz*rz);
    if (len > 1e-6) return [rx/len, ry/len, rz/len];
  }
  // Fallback: infer from wallSide property
  const wallSide = elem.properties?.wallSide;
  if (wallSide === 'SOUTH' || wallSide === 'NORTH') return [1, 0, 0];
  if (wallSide === 'EAST' || wallSide === 'WEST') return [0, 1, 0];
  // Last resort: original behavior (geometry.direction)
  const d = elem.geometry?.direction || {};
  const dx = d.x ?? d[0] ?? 1;
  const dy = d.y ?? d[1] ?? 0;
  const dz = d.z ?? d[2] ?? 0;
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  return len > 1e-6 ? [dx/len, dy/len, dz/len] : [1, 0, 0];
}

function getWallLength(elem) {
  const p = elem.geometry?.profile || {};
  const w = p.width || 0, h = p.height || 0;
  if (w > 0 && h > 0) {
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio < AMBIGUOUS_RATIO_TOL) {
      ambiguousProfileCount++;
      console.log(`getWallLength: ambiguous profile ${w.toFixed(2)}x${h.toFixed(2)} (ratio ${ratio.toFixed(2)}) on ${elem.name || elem.id}`);
      return w; // convention: width = length dimension
    }
    return Math.max(w, h);
  }
  return w || h || elem.geometry?.depth || 1;
}

function setWallLength(elem, len) {
  const p = elem.geometry?.profile;
  if (!p) return;
  const w = p.width || 0, h = p.height || 0;
  const ratio = (w > 0 && h > 0) ? Math.max(w, h) / Math.min(w, h) : 999;
  if (ratio < AMBIGUOUS_RATIO_TOL) {
    p.width = len; // ambiguous — update width by convention
  } else if (w >= h) { p.width = len; }
  else { p.height = len; }
}

function getWallThickness(elem) {
  const p = elem.geometry?.profile || {};
  const w = p.width || 0, h = p.height || 0;
  if (w > 0 && h > 0) {
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio < AMBIGUOUS_RATIO_TOL) {
      ambiguousProfileCount++;
      console.log(`getWallThickness: ambiguous profile ${w.toFixed(2)}x${h.toFixed(2)} on ${elem.name || elem.id}`);
      return h; // convention: height = thickness dimension
    }
    return Math.min(w, h);
  }
  return w || h || 0;
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

  // Phase 4C: Interior coherence grading (metadata-only)
  const rooms = css.elements.filter(e => (e.type || '').toUpperCase() === 'SPACE' && !e.properties?.isTransitionHelper);
  const partitions = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL' && !e.properties?.isExternal && !e.properties?.isFallback);
  let interiorCoherence = 'ENVELOPE_ONLY';
  if (rooms.length >= 3 && partitions.length >= 2) {
    interiorCoherence = 'STRUCTURED_INTERIOR';
  } else if (rooms.length >= 1 || partitions.length >= 1) {
    interiorCoherence = 'PARTIAL_INTERIOR';
  }

  if (warnings.length > 0) {
    console.warn(`v6 Building validation: ${warnings.join('; ')}`);
  }
  if (!css.metadata) css.metadata = {};
  css.metadata.buildingValidationWarnings = warnings.length > 0 ? warnings : undefined;
  css.metadata.interiorCoherence = interiorCoherence;
}
