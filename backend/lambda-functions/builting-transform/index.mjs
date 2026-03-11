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

  // ========== STEP 4: MERGE WALLS ==========
  mergeWalls(css);
  console.log('Wall merge complete');

  // ========== STEP 5: INFER OPENINGS ==========
  inferOpenings(css);
  console.log('Opening inference complete');

  // ========== STEP 6: INFER SLABS ==========
  inferSlabs(css);
  console.log('Slab inference complete');

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
// WALL ALIGNMENT + MERGE (Phase 6A)
// ============================================================================

function mergeWalls(css) {
  if (!css.elements || css.elements.length === 0) return;

  const ANGLE_TOL = 3 * Math.PI / 180; // 3 degrees
  const SNAP_TOL = 5 * Math.PI / 180;  // 5 degrees for axis snap
  const ENDPOINT_TOL = 0.05; // meters
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
// OPENING INFERENCE (Phase 6B)
// ============================================================================

function inferOpenings(css) {
  if (!css.elements || css.elements.length === 0) return;

  const HOST_DISTANCE_TOL = 0.5; // meters

  const walls = css.elements.filter(e => (e.type === 'WALL' || e.semantic_type === 'WALL'));
  const openingCandidates = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return t === 'DOOR' || t === 'WINDOW';
  });

  if (walls.length === 0 || openingCandidates.length === 0) return;

  let matched = 0;
  for (const candidate of openingCandidates) {
    const candOrigin = getOrigin(candidate);
    const candContainer = candidate.container || 'level-1';

    let bestWall = null;
    let bestDist = Infinity;

    for (const wall of walls) {
      const wallContainer = wall.container || 'level-1';
      if (wallContainer !== candContainer) continue; // same storey only

      const wallOrigin = getOrigin(wall);
      const d = dist3(candOrigin, wallOrigin);
      if (d < bestDist) {
        bestDist = d;
        bestWall = wall;
      }
    }

    if (bestWall && bestDist <= HOST_DISTANCE_TOL) {
      if (!candidate.metadata) candidate.metadata = {};
      candidate.metadata.hostWallKey = bestWall.element_key || bestWall.id;
      matched++;
    }
    // If no wall within threshold, keep as-is (PROXY guardrail)
  }

  if (matched > 0) {
    console.log(`Matched ${matched} openings to host walls`);
  }
}


// ============================================================================
// SLAB INFERENCE (Phase 6C)
// ============================================================================

function inferSlabs(css) {
  if (!css.elements || css.elements.length === 0) return;

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
