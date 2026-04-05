import { safe, clamp, elemId, vecNormalize, vecDot, vecCross, vecScale, vecAdd, vecSub, vecDist, vecLen, canonicalWallDirection, canonicalWallLength, canonicalWallThickness, setCanonicalWallLength, storeyHeightFromOccupancy, shellThicknessFromProfile } from './shared.mjs';

/**
 * Data-driven tunnel detection — check for TUNNEL_SEGMENT elements rather than
 * relying on the domain string, so hybrid structures and mis-classified domains
 * are handled correctly. Cached on the css object to avoid repeated O(n) scans.
 */
function hasTunnelSegments(css) {
  if (css._hasTunnelSegmentsCache !== undefined) return css._hasTunnelSegmentsCache;
  const result = (css.elements || []).some(e => e.type === 'TUNNEL_SEGMENT');
  // Cache on object so repeated calls within one pipeline pass are free
  Object.defineProperty(css, '_hasTunnelSegmentsCache', { value: result, writable: true, configurable: true });
  return result;
}

// ============================================================================
// BUILDING ENVELOPE GUARANTEE (non-TUNNEL)
// ============================================================================

function guaranteeBuildingEnvelope(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const levels = css.levelsOrSegments || [];
  // Derive default storey height from occupancy rather than assuming 3m.
  const _occupancy = (css.facilityMeta || css.metadata?.facilityMeta || {}).occupancy || '';
  const _defaultH = storeyHeightFromOccupancy(_occupancy);
  const defaultLevel = levels[0] || { id: 'level-1', elevation_m: 0, height_m: _defaultH };
  const allWalls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');

  // Build storey metadata
  const storeyInfo = {};
  for (const level of levels) {
    storeyInfo[level.id] = { elevation: level.elevation_m || 0, height: level.height_m || _defaultH };
  }
  if (!storeyInfo[defaultLevel.id]) {
    storeyInfo[defaultLevel.id] = { elevation: 0, height: defaultLevel.height_m || _defaultH };
  }

  // Group walls and slabs by container
  const wallsByContainer = new Map();
  const slabsByContainer = new Map();
  for (const e of css.elements) {
    const c = e.container || defaultLevel.id;
    const t = (e.type || '').toUpperCase();
    if (t === 'WALL') {
      if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
      wallsByContainer.get(c).push(e);
    } else if (t === 'SLAB') {
      if (!slabsByContainer.has(c)) slabsByContainer.set(c, []);
      slabsByContainer.get(c).push(e);
    }
  }

  // Compute global bbox from WALLS only — prevents equipment/MEP from inflating
  // the building footprint, which would cause slabs and roof to overshoot.
  let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
  for (const w of allWalls) {
    const o = w.placement?.origin;
    if (!o) continue;
    const dir = canonicalWallDirection(w);
    const len = canonicalWallLength(w);
    if (dir && len > 0) {
      const s = vecAdd(o, vecScale(dir, -len / 2));
      const e = vecAdd(o, vecScale(dir, len / 2));
      gMinX = Math.min(gMinX, s.x, e.x); gMaxX = Math.max(gMaxX, s.x, e.x);
      gMinY = Math.min(gMinY, s.y, e.y); gMaxY = Math.max(gMaxY, s.y, e.y);
    } else {
      if (o.x < gMinX) gMinX = o.x; if (o.x > gMaxX) gMaxX = o.x;
      if (o.y < gMinY) gMinY = o.y; if (o.y > gMaxY) gMaxY = o.y;
    }
  }
  // Fallback to all elements if no walls have geometry yet
  if (!isFinite(gMinX)) {
    for (const e of css.elements) {
      const o = e.placement?.origin;
      if (!o) continue;
      if (o.x < gMinX) gMinX = o.x; if (o.x > gMaxX) gMaxX = o.x;
      if (o.y < gMinY) gMinY = o.y; if (o.y > gMaxY) gMaxY = o.y;
    }
  }
  if (!isFinite(gMinX)) return;

  const BOUNDARY_TOL = 0.5;
  for (const wall of allWalls) {
    if (wall.properties?.isExternal) continue;
    const wo = wall.placement?.origin;
    if (!wo) continue;
    const atBoundary = (
      Math.abs(wo.x - gMinX) < BOUNDARY_TOL || Math.abs(wo.x - gMaxX) < BOUNDARY_TOL ||
      Math.abs(wo.y - gMinY) < BOUNDARY_TOL || Math.abs(wo.y - gMaxY) < BOUNDARY_TOL
    );
    if (atBoundary) {
      if (!wall.properties) wall.properties = {};
      wall.properties.isExternal = true;
      wall.properties._externalInferred = true;
    }
  }

  const generated = [];

  // Process each container independently
  const containers = new Set(levels.map(l => l.id));
  if (containers.size === 0) containers.add(defaultLevel.id);

  for (const containerId of containers) {
    const containerWalls = wallsByContainer.get(containerId) || [];
    const containerSlabs = slabsByContainer.get(containerId) || [];
    const info = storeyInfo[containerId] || { elevation: 0, height: 3.0 };
    const storeyZ = info.elevation;
    const storeyH = info.height;

    // Compute per-container bbox from walls in this container
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const w of containerWalls) {
      const o = w.placement?.origin;
      if (!o) continue;
      const dir = canonicalWallDirection(w);
      const len = canonicalWallLength(w);
      if (dir) {
        const s = vecAdd(o, vecScale(dir, -len / 2));
        const e = vecAdd(o, vecScale(dir, len / 2));
        minX = Math.min(minX, s.x, e.x); maxX = Math.max(maxX, s.x, e.x);
        minY = Math.min(minY, s.y, e.y); maxY = Math.max(maxY, s.y, e.y);
      } else {
        minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
        minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
      }
    }

    // If no walls in container, use global bbox as fallback for this container
    if (!isFinite(minX)) {
      minX = gMinX; maxX = gMaxX; minY = gMinY; maxY = gMaxY;
    }

    const bboxW = Math.max(maxX - minX, 3.0);
    const bboxD = Math.max(maxY - minY, 3.0);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Generate fallback walls if this container has fewer than 4
    const extWalls = containerWalls.filter(w => w.properties?.isExternal);
    if (extWalls.length < 4 && containerWalls.length < 4) {
      const wallThickness = 0.25;
      const wallDefs = [
        { name: `North Wall`, ox: centerX, oy: maxY, dirX: 1, dirY: 0, len: bboxW },
        { name: `South Wall`, ox: centerX, oy: minY, dirX: 1, dirY: 0, len: bboxW },
        { name: `East Wall`, ox: maxX, oy: centerY, dirX: 0, dirY: 1, len: bboxD },
        { name: `West Wall`, ox: minX, oy: centerY, dirX: 0, dirY: 1, len: bboxD },
      ];
      for (const wd of wallDefs) {
        generated.push({
          id: `env-wall-${containerId}-${wd.name.toLowerCase().replace(/\s/g, '-')}`,
          element_key: `env-wall-${containerId}-${wd.name.toLowerCase().replace(/\s/g, '-')}`,
          type: 'WALL', name: wd.name, semanticType: 'IfcWall',
          confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: containerId,
          placement: {
            origin: { x: wd.ox, y: wd.oy, z: storeyZ },
            axis: { x: 0, y: 0, z: 1 },
            refDirection: { x: wd.dirX, y: wd.dirY, z: 0 }
          },
          geometry: {
            method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 },
            depth: storeyH, profile: { type: 'RECTANGLE', width: wd.len, height: wallThickness }
          },
          material: { name: 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 },
          properties: { isExternal: true, isFallback: true, isApproximation: true },
          relationships: []
        });
      }
    }

    // Generate floor slab if missing for this container
    const hasFloor = containerSlabs.some(s => !s.properties?.slabType || s.properties.slabType === 'FLOOR');
    if (!hasFloor) {
      generated.push({
        id: `env-floor-slab-${containerId}`, element_key: `env-floor-slab-${containerId}`,
        type: 'SLAB', name: 'Floor Slab', semanticType: 'IfcSlab',
        confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: containerId,
        placement: {
          origin: { x: centerX, y: centerY, z: storeyZ },
          axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
        },
        geometry: {
          method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: 0.2,
          profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
        },
        material: { name: 'concrete_floor', color: [0.65, 0.65, 0.65], transparency: 0 },
        properties: { slabType: 'FLOOR', isFallback: true, isApproximation: true },
        relationships: []
      });
    }
  }

  // Safety net: if NO floor slab exists across ALL containers, force one at the global footprint
  const anyFloor = css.elements.some(e =>
    (e.type || '').toUpperCase() === 'SLAB' &&
    (!e.properties?.slabType || e.properties.slabType === 'FLOOR')
  ) || generated.some(e => e.properties?.slabType === 'FLOOR');
  if (!anyFloor) {
    const floorBboxW = Math.max(gMaxX - gMinX, 3.0);
    const floorBboxD = Math.max(gMaxY - gMinY, 3.0);
    // Use median wall base Z for floor elevation
    const wallBasesAll = [];
    for (const w of allWalls) {
      const wz = w.placement?.origin?.z;
      if (typeof wz === 'number') wallBasesAll.push(wz);
    }
    const floorZ = wallBasesAll.length > 0
      ? wallBasesAll.sort((a, b) => a - b)[Math.floor(wallBasesAll.length / 2)]
      : 0;
    generated.push({
      id: 'env-floor-safety', element_key: 'env-floor-safety',
      type: 'SLAB', name: 'Floor Slab', semanticType: 'IfcSlab',
      confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: defaultLevel.id,
      placement: {
        origin: { x: (gMinX + gMaxX) / 2, y: (gMinY + gMaxY) / 2, z: floorZ },
        axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: 0.2,
        profile: { type: 'RECTANGLE', width: floorBboxW, height: floorBboxD }
      },
      material: { name: 'concrete_floor', color: [0.65, 0.65, 0.65], transparency: 0 },
      properties: { slabType: 'FLOOR', isFallback: true, isApproximation: true },
      relationships: []
    });
    console.log(`guaranteeBuildingEnvelope: safety-net floor slab at z=${floorZ}`);
  }

  // Roof slab: generate once at the top of the building (last container)
  const allRoofSlabs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' && (e.properties?.slabType || '').toUpperCase() === 'ROOF'
  );
  // Check if existing roof slabs are actually large enough to be visible
  const hasVisibleRoof = allRoofSlabs.some(s => {
    const p = s.geometry?.profile;
    return p && (p.width || 0) > 2.0 && (p.height || 0) > 2.0;
  });
  if (!hasVisibleRoof) {
    const lastLevel = levels.length > 0 ? levels[levels.length - 1] : defaultLevel;
    const roofContainer = lastLevel.id || defaultLevel.id;

    // Compute roof Z from actual wall tops (most reliable), fall back to storey metadata
    let roofZ = null;
    const allWallsForRoof = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
    const wallTops = [];
    for (const w of allWallsForRoof) {
      const wz = w.placement?.origin?.z;
      const wd = w.geometry?.depth;
      if (typeof wz === 'number' && typeof wd === 'number' && wd > 0) {
        wallTops.push(wz + wd);
      }
    }
    if (wallTops.length > 0) {
      wallTops.sort((a, b) => b - a);
      // Use median of top-3 tallest walls
      const topN = wallTops.slice(0, Math.min(3, wallTops.length));
      roofZ = topN[Math.floor(topN.length / 2)];
    }
    if (roofZ === null) {
      roofZ = (lastLevel.elevation_m || 0) + (lastLevel.height_m || 3.0);
    }

    const bboxW = Math.max(gMaxX - gMinX, 3.0);
    const bboxD = Math.max(gMaxY - gMinY, 3.0);
    generated.push({
      id: 'env-roof-slab', element_key: 'env-roof-slab',
      type: 'SLAB', name: 'Roof Slab', semanticType: 'IfcSlab',
      confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: roofContainer,
      placement: {
        origin: { x: (gMinX + gMaxX) / 2, y: (gMinY + gMaxY) / 2, z: roofZ },
        axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: 0.2,
        profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
      },
      material: { name: 'metal_roof', color: [0.4, 0.45, 0.5], transparency: 0 },
      properties: { slabType: 'ROOF', isFallback: true, isApproximation: true },
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
      originalWalls: allWalls.length,
      containersProcessed: containers.size
    };
    console.log(`guaranteeBuildingEnvelope: generated ${generated.length} fallback elements across ${containers.size} container(s)`);
  }
}


// ============================================================================
// PHASE 4A: OPENING PLACEMENT VALIDATION (non-TUNNEL)
// Conservative: wrong visible geometry is worse than missing geometry.
// ============================================================================

function validateOpeningPlacement(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

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
    let bestDist = Infinity;
    const hostKey = opening.properties?.hostWallKey;
    if (hostKey) {
      hostWall = walls.find(w => (w.element_key || w.id) === hostKey);
    }
    if (!hostWall) {
      // Find nearest wall — use relaxed threshold for inferred openings
      const isInferred = opening.properties?.inferredFromBuildingType === true;
      const maxHostDist = isInferred ? 5.0 : 2.0;
      for (const w of walls) {
        const wo = w.placement?.origin;
        if (!wo) continue;
        const d = vecDist(oo, wo);
        if (d < bestDist) { bestDist = d; hostWall = w; }
      }
      if (bestDist > maxHostDist) hostWall = null;
    }

    if (!hostWall) {
      // No host — downgrade
      console.log(`Opening dropped: ${opening.name || opening.id} (${opening.type}) nearestWall=${bestDist.toFixed(2)}m reason=no_host_wall`);
      unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'no_host_wall', nearestDist: +bestDist.toFixed(2) });
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
      const isInferred = opening.properties?.inferredFromBuildingType === true;
      const minConfForRehost = isInferred ? 0.3 : 0.6;
      const maxRehostDist = isInferred ? 3.0 : 0.5;
      if (confidence >= minConfForRehost) {
        // Try rehosting to nearest wall within threshold
        let bestRehost = null;
        let bestRehostDist = maxRehostDist;
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
          console.log(`Opening dropped: ${opening.name || opening.id} (${opening.type}) dist=${dist.toFixed(2)}m reason=outside_bounds_no_rehost`);
          unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'outside_bounds_no_rehost', dist: +dist.toFixed(2) });
          removeKeys.add(opening.element_key || opening.id);
          downgraded++;
        }
      } else {
        console.log(`Opening dropped: ${opening.name || opening.id} (${opening.type}) dist=${dist.toFixed(2)}m conf=${confidence} reason=low_confidence`);
        unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'outside_bounds_low_confidence', dist: +dist.toFixed(2) });
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
      if (Math.abs(oo.z - floorZ) < 0.5) {
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
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  if (walls.length < 2) return;

  const ANGLE_CAP = 10 * Math.PI / 180; // 10°
  const POSITION_CAP = 0.3; // 0.3m max movement
  const LINE_OFFSET_TOL = 0.2; // 0.2m for collinear detection

  // Group by approximate direction (uses canonical direction from shared.mjs)
  const groups = [];
  for (const wall of walls) {
    const dir = canonicalWallDirection(wall);
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
      const currentDir = canonicalWallDirection(wall);
      if (!currentDir) continue;
      const dot = Math.abs(vecDot(currentDir, avgDir));
      if (dot >= 0.9998) continue; // already aligned

      // Check endpoint shift from direction change doesn't exceed POSITION_CAP
      const wallLen = canonicalWallLength(wall);
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
// WALL ENVELOPE CLAMPING (BUILDING only)
// Trims interior partition wall endpoints so they don't extend beyond the
// building envelope (defined by exterior walls or overall bounding box).
// ============================================================================

function clampWallsToEnvelope(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Compute envelope from exterior walls (or fallback to all-element bbox)
  const exteriorWalls = css.elements.filter(e =>
    e.type === 'WALL' && e.properties?.isExternal === true
  );

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const wallsForBbox = exteriorWalls.length >= 4 ? exteriorWalls : css.elements;
  for (const e of wallsForBbox) {
    const o = e.placement?.origin;
    if (!o || !isFinite(o.x) || !isFinite(o.y)) continue;
    if (o.x < minX) minX = o.x;
    if (o.x > maxX) maxX = o.x;
    if (o.y < minY) minY = o.y;
    if (o.y > maxY) maxY = o.y;
  }

  if (!isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return;

  const MARGIN = 0.5; // allow walls to extend 0.5m beyond envelope (for wall thickness)
  const envMinX = minX - MARGIN, envMaxX = maxX + MARGIN;
  const envMinY = minY - MARGIN, envMaxY = maxY + MARGIN;

  let clampCount = 0;

  for (const wall of css.elements) {
    if (wall.type !== 'WALL') continue;
    if (wall.properties?.isExternal) continue; // don't clamp exterior walls

    const o = wall.placement?.origin;
    if (!o) continue;

    const dir = canonicalWallDirection(wall);
    const len = canonicalWallLength(wall);
    if (!dir || len <= 0) continue;

    // Compute wall endpoints
    const startX = o.x - dir.x * len / 2;
    const startY = o.y - dir.y * len / 2;
    const endX = o.x + dir.x * len / 2;
    const endY = o.y + dir.y * len / 2;

    // Check if either endpoint is outside envelope
    let newStartX = startX, newStartY = startY, newEndX = endX, newEndY = endY;
    let clamped = false;

    // Clamp along the wall direction
    if (Math.abs(dir.x) > 0.5) {
      // Wall runs primarily along X
      if (newStartX < envMinX) { newStartX = envMinX; clamped = true; }
      if (newEndX > envMaxX) { newEndX = envMaxX; clamped = true; }
      if (newStartX > envMaxX) { newStartX = envMaxX; clamped = true; }
      if (newEndX < envMinX) { newEndX = envMinX; clamped = true; }
    }
    if (Math.abs(dir.y) > 0.5) {
      // Wall runs primarily along Y
      if (newStartY < envMinY) { newStartY = envMinY; clamped = true; }
      if (newEndY > envMaxY) { newEndY = envMaxY; clamped = true; }
      if (newStartY > envMaxY) { newStartY = envMaxY; clamped = true; }
      if (newEndY < envMinY) { newEndY = envMinY; clamped = true; }
    }

    if (clamped) {
      // Recompute origin (midpoint) and length
      const newLen = Math.sqrt((newEndX - newStartX) ** 2 + (newEndY - newStartY) ** 2);
      if (newLen < 0.1) continue; // wall fully outside envelope, too small after clamp

      o.x = (newStartX + newEndX) / 2;
      o.y = (newStartY + newEndY) / 2;
      setCanonicalWallLength(wall, newLen);
      clampCount++;
    }
  }

  if (clampCount > 0) {
    console.log(`clampWallsToEnvelope: clamped ${clampCount} interior walls to building footprint`);
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
    SLAB: { minW: 0.5, maxW: 500, minH: 0.5, maxH: 500, minD: 0.05, maxD: 1.5 },
    COLUMN: { minW: 0.1, maxW: 2.0, minH: 0.1, maxH: 2.0, minD: 0.5, maxD: 20 },
    BEAM: { minW: 0.1, maxW: 2.0, minH: 0.1, maxH: 2.0, minD: 0.5, maxD: 50 },
    SPACE: { minW: 0.5, maxW: 200, minH: 0.5, maxH: 200, minD: 0.5, maxD: 5000 },
    EQUIPMENT: { minW: 0.01, maxW: 20, minH: 0.01, maxH: 20, minD: 0.01, maxD: 20 },
    DOOR: { minW: 0.3, maxW: 5.0, minH: 0.03, maxH: 1.0, minD: 0.5, maxD: 4.0 },
    WINDOW: { minW: 0.3, maxW: 5.0, minH: 0.03, maxH: 1.0, minD: 0.3, maxD: 3.0 },
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
  if (hasTunnelSegments(css)) {
    console.log('MergeWalls: skipping for TUNNEL domain (shell walls are independent)');
    return;
  }

  const ANGLE_TOL = 3 * Math.PI / 180; // 3 degrees
  const ENDPOINT_TOL = 0.40; // meters (Phase 2: increased from 0.20, safe with perpendicular offset guard)
  const THICKNESS_TOL = 0.10; // 10% relative

  // Only process WALL elements
  const walls = css.elements.filter(e => (e.type === 'WALL' || e.semantic_type === 'WALL'));
  if (walls.length < 2) return;

  // Direction alignment is handled by cleanBuildingWallAxes (operates on refDirection).
  // The old geometry.direction snap was removed — it incorrectly snapped the extrusion
  // axis (Z-up) instead of the wall run direction.

  // Resolve canonical direction for all walls upfront so merge uses consistent values
  for (const wall of walls) canonicalWallDirection(wall);

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
        const aLen = canonicalWallLength(a);
        const bLen = canonicalWallLength(b);
        const aDirV = canonicalWallDirection(a);
        const aDir = aDirV ? [aDirV.x, aDirV.y, aDirV.z] : [1, 0, 0];

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
        setCanonicalWallLength(a, newLen);

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
  const dirAv = canonicalWallDirection(a);
  const dirBv = canonicalWallDirection(b);
  if (!dirAv || !dirBv) return false;
  const dirA = [dirAv.x, dirAv.y, dirAv.z];
  const dirB = [dirBv.x, dirBv.y, dirBv.z];

  // Check angle between directions (use absolute dot product for anti-parallel)
  const dot = Math.abs(dirA[0]*dirB[0] + dirA[1]*dirB[1] + dirA[2]*dirB[2]);
  if (dot < Math.cos(angleTol)) return false;

  // Check thickness compatibility (within 10%)
  const thickA = canonicalWallThickness(a);
  const thickB = canonicalWallThickness(b);
  if (thickA > 0 && thickB > 0) {
    const ratio = Math.abs(thickA - thickB) / Math.max(thickA, thickB);
    if (ratio > thicknessTol) return false;
  }

  // Check perpendicular offset — reject parallel but laterally offset walls
  const aOrigin = getOrigin(a);
  const bOrigin = getOrigin(b);
  const abVec = [bOrigin[0] - aOrigin[0], bOrigin[1] - aOrigin[1], bOrigin[2] - aOrigin[2]];
  const proj = abVec[0]*dirA[0] + abVec[1]*dirA[1] + abVec[2]*dirA[2];
  const perpVec = [abVec[0] - dirA[0]*proj, abVec[1] - dirA[1]*proj, abVec[2] - dirA[2]*proj];
  const perpDist = Math.sqrt(perpVec[0]**2 + perpVec[1]**2 + perpVec[2]**2);
  const maxPerp = Math.max((thickA + thickB) / 4, 0.10); // half avg thickness, min 0.10m
  if (perpDist > maxPerp) return false;

  // Check if endpoints are close enough
  const aLen = canonicalWallLength(a);
  const bLen = canonicalWallLength(b);

  const aEnd1 = [aOrigin[0] - dirA[0]*aLen/2, aOrigin[1] - dirA[1]*aLen/2, aOrigin[2] - dirA[2]*aLen/2];
  const aEnd2 = [aOrigin[0] + dirA[0]*aLen/2, aOrigin[1] + dirA[1]*aLen/2, aOrigin[2] + dirA[2]*aLen/2];
  const bEnd1 = [bOrigin[0] - dirB[0]*bLen/2, bOrigin[1] - dirB[1]*bLen/2, bOrigin[2] - dirB[2]*bLen/2];
  const bEnd2 = [bOrigin[0] + dirB[0]*bLen/2, bOrigin[1] + dirB[1]*bLen/2, bOrigin[2] + dirB[2]*bLen/2];

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

// Legacy wrappers — delegate to canonical helpers from shared.mjs
function getDir(elem) {
  const d = canonicalWallDirection(elem);
  return d ? [d.x, d.y, d.z] : [1, 0, 0];
}
function getWallLength(elem) { return canonicalWallLength(elem); }
function setWallLength(elem, len) { setCanonicalWallLength(elem, len); }
function getWallThickness(elem) { return canonicalWallThickness(elem); }

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

// Horizontal wall helpers — delegate to canonical versions
function getWallHorizontalLength(wall) { return canonicalWallLength(wall); }
function getWallHorizontalAxis(wall) {
  const d = canonicalWallDirection(wall);
  return d ? [d.x, d.y, d.z] : [1, 0, 0];
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

function getWallThicknessFromProfile(wall) { return canonicalWallThickness(wall); }

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
  // Derive normal from refDirection if available (set by extract or alignment)
  const ref = elem.placement?.refDirection;
  if (ref) {
    const rx = ref.x || 0, ry = ref.y || 0;
    // Opening normal is perpendicular to refDirection (wall-through direction)
    const len = Math.sqrt(rx * rx + ry * ry);
    if (len > 1e-9) {
      return [-ry / len, rx / len, 0]; // perpendicular in XY plane
    }
  }
  // Fallback: try both directions — the scoring function tests both orientations anyway
  return [0, 1, 0];
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

  const isTunnel = hasTunnelSegments(css);

  // Tunnel domain: assign doors/windows to nearest valid host.
  // Search both STRUCTURAL TUNNEL_SEGMENTs and PORTAL_END_WALL closure walls.
  // PORTAL_END_WALL gets priority when distances are similar (doors belong at tunnel mouths).
  if (isTunnel) {
    const tunnelHosts = css.elements.filter(e => {
      const t = (e.type || '').toUpperCase();
      if (t === 'TUNNEL_SEGMENT' && (e.properties?.branchClass || '').toUpperCase() === 'STRUCTURAL') return true;
      if (t === 'WALL' && e.properties?.segmentType === 'PORTAL_END_WALL') return true;
      return false;
    });
    const openingCandidates = css.elements.filter(e => {
      const t = (e.type || '').toUpperCase();
      return t === 'DOOR' || t === 'WINDOW';
    });
    if (tunnelHosts.length === 0 || openingCandidates.length === 0) return;

    let matched = 0;
    for (const candidate of openingCandidates) {
      const o = getOrigin(candidate);
      let bestKey = null, bestDist = Infinity;
      let bestIsPortal = false;
      for (const host of tunnelHosts) {
        const { start, end } = getWallEndpoints(host);
        const { perpDist, tClamped } = projectPointToSegment(o, start, end);
        if (tClamped >= 0 && tClamped <= 1 && perpDist < 15.0) {
          const isPortal = host.properties?.segmentType === 'PORTAL_END_WALL';
          // PORTAL_END_WALL gets priority: prefer it unless segment is much closer (>3m difference)
          const effectiveDist = isPortal ? perpDist * 0.5 : perpDist;
          if (effectiveDist < bestDist) {
            bestDist = effectiveDist;
            bestKey = host.element_key || host.id;
            bestIsPortal = isPortal;
          }
        }
      }
      if (bestKey) {
        if (!candidate.metadata) candidate.metadata = {};
        candidate.metadata.hostWallKey = bestKey;
        candidate.metadata.hostWallMatchScore = Math.max(0, 1 - bestDist / 15.0);
        candidate.metadata.hostIsPortalEndWall = bestIsPortal;
        matched++;

        // Tunnel door Z-snap: set door Z to tunnel floor level (bottom of host segment).
        // validateOpeningPlacement skips tunnels, so this is the only Z correction path.
        if ((candidate.type || '').toUpperCase() === 'DOOR' && candidate.placement?.origin) {
          const host = tunnelHosts.find(h => (h.element_key || h.id) === bestKey);
          if (host) {
            const hostZ = host.placement?.origin?.z ?? 0;
            const hostH = host.geometry?.profile?.height ?? 5;
            const shellT = host.properties?.shellThickness_m ?? 0.3;
            const floorZ = hostZ - hostH / 2 + shellT;
            const doorH = candidate.geometry?.profile?.height
                       || candidate.geometry?.depth || 2.1;
            // Place door origin at floor + half door height (origin = center)
            candidate.placement.origin.z = floorZ + doorH / 2;
            console.log(`Tunnel door Z-snap: ${candidate.name || candidate.id} z=${candidate.placement.origin.z.toFixed(2)} (floor=${floorZ.toFixed(2)}, hostZ=${hostZ.toFixed(2)})`);
          }
        }
      }
    }
    console.log(`InferOpenings (tunnel): ${matched} of ${openingCandidates.length} doors/windows matched (portal end walls included)`);
    return;
  }

  const PERP_DIST_MAX = 1.0;         // max perpendicular distance to wall line
  const SEGMENT_TOL = 0.2;           // opening can extend 0.2m past wall endpoints
  const ORIENTATION_TOL = 0.2;       // |dot(openingNormal, wallAxis)| must be < this
  const WIDTH_RATIO_MAX = 0.8;       // opening width must be < 80% of wall length
  const AMBIGUITY_RATIO = 0.92;      // only skip if scores are nearly identical (was 0.7 — too strict)
  const SALVAGE_PERP_MAX = 3.0;      // salvage pass: max perpendicular distance (was 1.5 — too small for thick walls)
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
      candidate.metadata.isInferred = true;
      // Mark evidence basis as inferred for provenance tracking
      if (!candidate.metadata.evidence) candidate.metadata.evidence = {};
      candidate.metadata.evidence.basis = 'INFERRED_OPENING_SNAP';
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

  // Build a map of walls (and tunnel segments) by key for quick lookup
  const wallMap = {};
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t === 'WALL' || t === 'TUNNEL_SEGMENT') {
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
    let hostWall = wallMap[wallKey];

    // Host wall must still exist — if not, try resolving through derivedFromBranch
    // lineage (the original tunnel segment may have been decomposed into shell walls
    // with different IDs by decomposeTunnelShell)
    if (!hostWall) {
      const fallbackWall = css.elements.find(e => {
        const t = (e.type || '').toUpperCase();
        return (t === 'WALL' || t === 'TUNNEL_SEGMENT') &&
          (e.properties?.derivedFromBranch === wallKey || e.properties?.hostBranch === wallKey);
      });
      if (fallbackWall) {
        hostWall = fallbackWall;
        opening.metadata.hostWallKey = fallbackWall.element_key || fallbackWall.id;
        opening.metadata.hostWallResolved = 'derived_branch_fallback';
      }
    }
    if (!hostWall) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'host_wall_missing');
      skipped++;
      continue;
    }

    const hostType = (hostWall.type || '').toUpperCase();
    const isTunnelHost = hostType === 'TUNNEL_SEGMENT';

    // Tunnel-hosted openings: skip building-specific geometry checks (wall span, endpoint
    // proximity) since a tunnel segment's "width" is its cross-section, not its run length.
    // We only validate that the door dimensions are sane (not bigger than the tube interior).
    if (isTunnelHost) {
      const tunnelW = hostWall.geometry?.profile?.width || 5;
      const tunnelH = hostWall.geometry?.profile?.height || 5;
      const openingWidth = getOpeningWidth(opening);
      const openingHeight = getOpeningHeight(opening);
      if (openingWidth >= tunnelW * 0.9 || openingHeight >= tunnelH * 0.9) {
        _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_too_large_for_tunnel');
        skipped++;
        continue;
      }
      // All checks passed — create VOIDS relationship.
      // Use element_key as the canonical target (validator builds elementKeys from element_key).
      if (!opening.relationships) opening.relationships = [];
      opening.relationships.push({ type: 'VOIDS', target: hostWall.element_key || hostWall.id });
      if (!opening.metadata) opening.metadata = {};
      opening.metadata.openingVoidsCreated = true;
      created++;
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

    // All checks passed — create VOIDS relationship.
    // Use element_key as the canonical target (validator builds elementKeys from element_key).
    if (!opening.relationships) opening.relationships = [];
    opening.relationships.push({ type: 'VOIDS', target: hostWall.element_key || hostWall.id });
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
  if (hasTunnelSegments(css)) {
    console.log('InferSlabs: skipping for TUNNEL domain (shell slabs pre-classified)');
    return;
  }

  // Compute wall base and top Z ranges per container for geometric slab typing
  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const wallBasesByContainer = new Map();
  const wallTopsByContainer = new Map();
  for (const wall of walls) {
    const c = wall.container || '_default';
    const oz = wall.placement?.origin?.z;
    const depth = wall.geometry?.depth;
    if (typeof oz !== 'number') continue;
    if (!wallBasesByContainer.has(c)) wallBasesByContainer.set(c, []);
    wallBasesByContainer.get(c).push(oz);
    if (typeof depth === 'number' && depth > 0) {
      if (!wallTopsByContainer.has(c)) wallTopsByContainer.set(c, []);
      wallTopsByContainer.get(c).push(oz + depth);
    }
  }

  let upgraded = 0;
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t !== 'SLAB') continue;
    if (!elem.properties) elem.properties = {};
    if (elem.properties.slabType) continue; // already typed

    const slabZ = elem.placement?.origin?.z;
    if (typeof slabZ !== 'number') {
      elem.properties.slabType = 'FLOOR';
      upgraded++;
      continue;
    }

    const c = elem.container || '_default';
    const bases = wallBasesByContainer.get(c) || [];
    const tops = wallTopsByContainer.get(c) || [];

    if (bases.length > 0 && tops.length > 0) {
      // Geometric: compare slab Z to wall bases and tops
      const sortedBases = [...bases].sort((a, b) => a - b);
      const medianBase = sortedBases[Math.floor(sortedBases.length / 2)];
      const sortedTops = [...tops].sort((a, b) => b - a);
      const medianTop = sortedTops[Math.floor(sortedTops.length / 2)];

      const distToBase = Math.abs(slabZ - medianBase);
      const distToTop = Math.abs(slabZ - medianTop);

      if (distToTop < distToBase && distToTop < 1.0) {
        elem.properties.slabType = 'ROOF';
      } else {
        elem.properties.slabType = 'FLOOR';
      }
    } else {
      // Fallback: storey index (original logic)
      const levels = css.levelsOrSegments || [];
      const levelIndex = levels.findIndex(l => l.id === c);
      if (levelIndex === levels.length - 1 && levels.length > 1 && levelIndex > 0) {
        elem.properties.slabType = 'ROOF';
      } else {
        elem.properties.slabType = 'FLOOR';
      }
    }
    upgraded++;
  }

  if (upgraded > 0) {
    console.log(`InferSlabs: assigned slabType to ${upgraded} slab(s) using geometric Z-proximity`);
  }
}


// ============================================================================
// ENVELOPE FALLBACK (v3.2)
// ============================================================================

function checkEnvelopeFallback(css) {
  if (!css.metadata) return;
  if (hasTunnelSegments(css)) return;

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
  if (hasTunnelSegments(css)) return;

  const bbox = css.metadata?.bbox;
  if (!bbox) return;

  const warnings = [];
  const STOREY_Z_TOL = 0.5; // elements should be within ±0.5m of storey elevation

  // Build storey elevation and height maps
  const storeyElevations = {};
  const storeyHeights = {};
  for (const level of css.levelsOrSegments || []) {
    storeyElevations[level.id] = level.elevation_m || 0;
    storeyHeights[level.id] = level.height_m || 3;
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
    if (actualZ !== undefined && Math.abs(actualZ - expectedZ) > STOREY_Z_TOL + (storeyHeights[container] || 3)) {
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


// ============================================================================
// ROOF DEDUPLICATION — removes ROOF elements that duplicate a SLAB with slabType=ROOF
// at the same position. Keeps the SLAB representation (it gets material layers in generate).
// ============================================================================

function deduplicateRoofs(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const roofElements = css.elements.filter(e => (e.type || '').toUpperCase() === 'ROOF');
  const slabRoofs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' &&
    (e.properties?.slabType || '').toUpperCase() === 'ROOF'
  );

  if (roofElements.length === 0 || slabRoofs.length === 0) return;

  const removeIds = new Set();
  for (const roof of roofElements) {
    const ro = roof.placement?.origin || {};
    const rContainer = roof.container || '';
    const rz = ro.z || 0;
    const rProf = roof.geometry?.profile || {};
    const rw = rProf.width || 0;
    const rh = rProf.height || 0;
    for (const slab of slabRoofs) {
      const so = slab.placement?.origin || {};
      const sContainer = slab.container || '';
      if (rContainer !== sContainer) continue;
      const dx = (ro.x || 0) - (so.x || 0);
      const dy = (ro.y || 0) - (so.y || 0);
      const dz = rz - (so.z || 0);
      const xyDist = Math.sqrt(dx * dx + dy * dy);
      // Require: same container, XY within 0.5m, Z within 1m, dimensions similar (within 50%)
      if (xyDist > 0.5) continue;
      if (Math.abs(dz) > 1.0) continue;
      const sProf = slab.geometry?.profile || {};
      const sw = sProf.width || 0;
      const sh = sProf.height || 0;
      if (rw > 0 && sw > 0 && (Math.abs(rw - sw) / Math.max(rw, sw)) > 0.5) continue;
      if (rh > 0 && sh > 0 && (Math.abs(rh - sh) / Math.max(rh, sh)) > 0.5) continue;
      removeIds.add(roof.id || roof.element_key);
      break;
    }
  }

  if (removeIds.size > 0) {
    css.elements = css.elements.filter(e => !removeIds.has(e.id) && !removeIds.has(e.element_key));
    console.log(`DeduplicateRoofs: removed ${removeIds.size} ROOF element(s) that duplicate SLAB-ROOF at same position`);
  }
}

/**
 * Validate space/room container assignments and Z values.
 * Ensures every SPACE element has a valid container and its Z is clamped
 * to the storey elevation or host segment origin.
 */
function validateSpaceContainment(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Build storey elevation map
  const storeyElevations = {};
  for (const level of css.levelsOrSegments || []) {
    storeyElevations[level.id] = level.elevation_m || 0;
  }
  const defaultContainer = (css.levelsOrSegments || [])[0]?.id || 'level-1';

  // Build wall floor Z per container (median wall base)
  const wallBasesByContainer = new Map();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'WALL') continue;
    const c = e.container || defaultContainer;
    const z = e.placement?.origin?.z;
    if (typeof z !== 'number') continue;
    if (!wallBasesByContainer.has(c)) wallBasesByContainer.set(c, []);
    wallBasesByContainer.get(c).push(z);
  }

  let corrected = 0;
  for (const elem of css.elements) {
    if ((elem.type || '').toUpperCase() !== 'SPACE') continue;

    // Ensure valid container
    if (!elem.container || !storeyElevations.hasOwnProperty(elem.container)) {
      elem.container = defaultContainer;
    }

    // Clamp Z to storey elevation if it looks wrong
    const o = elem.placement?.origin;
    if (!o || typeof o.z !== 'number') continue;

    const storeyZ = storeyElevations[elem.container] || 0;
    const wallBases = wallBasesByContainer.get(elem.container);
    const targetZ = wallBases && wallBases.length > 0
      ? wallBases.sort((a, b) => a - b)[Math.floor(wallBases.length / 2)]
      : storeyZ;

    // If space Z differs from expected floor by more than 1m, snap it
    if (Math.abs(o.z - targetZ) > 1.0) {
      o.z = targetZ;
      if (!elem.properties) elem.properties = {};
      elem.properties._containerZCorrected = true;
      corrected++;
    }
  }

  if (corrected > 0) {
    console.log(`validateSpaceContainment: corrected ${corrected} space(s) Z to match storey/wall floor`);
  }
}

/**
 * Infer IfcSpace elements for building containers that have walls but no rooms.
 * Simple bbox approach: if a container has >= 4 walls, create one space from the
 * wall footprint. Does NOT attempt graph-based closed-loop detection (too risky).
 */
function inferSpaces(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Check if any SPACE elements already exist from extract
  const existingSpaces = css.elements.filter(e => (e.type || '').toUpperCase() === 'SPACE');
  if (existingSpaces.length > 0) {
    console.log(`inferSpaces: ${existingSpaces.length} spaces already exist from extract, skipping`);
    return;
  }

  const levels = css.levelsOrSegments || [];
  const defaultContainer = levels[0]?.id || 'level-1';

  // Group walls by container
  const wallsByContainer = new Map();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'WALL') continue;
    const c = e.container || defaultContainer;
    if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
    wallsByContainer.get(c).push(e);
  }

  // Build storey elevation map
  const storeyInfo = {};
  for (const level of levels) {
    storeyInfo[level.id] = { elevation: level.elevation_m || 0, height: level.height_m || 3.0 };
  }

  let created = 0;
  const generated = [];

  for (const [containerId, containerWalls] of wallsByContainer) {
    if (containerWalls.length < 4) continue;

    // Compute wall footprint bbox
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const wall of containerWalls) {
      const o = wall.placement?.origin;
      if (!o) continue;
      const dir = canonicalWallDirection(wall);
      const len = canonicalWallLength(wall);
      if (dir) {
        const s = vecAdd(o, vecScale(dir, -len / 2));
        const e = vecAdd(o, vecScale(dir, len / 2));
        minX = Math.min(minX, s.x, e.x); maxX = Math.max(maxX, s.x, e.x);
        minY = Math.min(minY, s.y, e.y); maxY = Math.max(maxY, s.y, e.y);
      } else {
        minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
        minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
      }
    }
    if (!isFinite(minX)) continue;

    const spaceW = maxX - minX;
    const spaceD = maxY - minY;
    if (spaceW < 1.0 || spaceD < 1.0) continue; // too small to be a room

    const info = storeyInfo[containerId] || { elevation: 0, height: 3.0 };
    const spaceZ = info.elevation;
    const spaceH = info.height;

    // Inset slightly from wall faces (use median wall thickness as margin)
    const thicknesses = containerWalls.map(w => canonicalWallThickness(w)).filter(t => t > 0);
    const inset = thicknesses.length > 0
      ? thicknesses.sort((a, b) => a - b)[Math.floor(thicknesses.length / 2)]
      : 0.2;

    const innerW = Math.max(1.0, spaceW - 2 * inset);
    const innerD = Math.max(1.0, spaceD - 2 * inset);

    generated.push({
      id: `inferred-space-${containerId}`,
      element_key: `inferred-space-${containerId}`,
      type: 'SPACE',
      name: `Room (${containerId})`,
      semanticType: 'IfcSpace',
      confidence: 0.4,
      source: 'INFERRED',
      container: containerId,
      placement: {
        origin: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: spaceZ },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: spaceH,
        profile: { type: 'RECTANGLE', width: innerW, height: innerD }
      },
      material: { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 },
      properties: { usage: 'GENERAL', isInferred: true },
      relationships: []
    });
    created++;
  }

  if (generated.length > 0) {
    css.elements.push(...generated);
    console.log(`inferSpaces: created ${created} inferred space(s) from wall footprints`);
  }
}

export {
  mergeWalls, inferOpenings, createOpeningRelationships,
  validateOpeningPlacement, inferSlabs, guaranteeBuildingEnvelope,
  cleanBuildingWallAxes, checkEnvelopeFallback, validateBuildingStructure,
  clampAbsurdDimensions, clampWallsToEnvelope, snapWallEndpoints, alignSlabsToWalls,
  countAmbiguousProfiles, deduplicateRoofs,
  deriveRoofElevation, snapSlabsToWallBases, snapWallsToStoreyFloor, snapTunnelSegmentEndpoints,
  validateSpaceContainment, inferSpaces
};

// Ambiguous profile count — now counted from canonical helper annotations
let ambiguousProfileCount = 0;
export function getAmbiguousProfileCount() { return ambiguousProfileCount; }
export function resetAmbiguousProfileCount() { ambiguousProfileCount = 0; }
function countAmbiguousProfiles(css) {
  ambiguousProfileCount = (css.elements || []).filter(e =>
    e.type === 'WALL' && e.properties?._ambiguousProfile
  ).length;
}

// ============================================================================
// ENDPOINT SNAPPING (Phase 2C)
// ============================================================================

/**
 * Snap wall endpoints to shared positions so walls share exact junction points.
 * Clusters endpoints within SNAP_RADIUS, snaps each cluster to its centroid,
 * then adjusts wall origins + lengths to match.
 */
function snapWallEndpoints(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Tiered snapping: Pass 1 at 50mm (high-confidence), Pass 2 at 300mm (repair orphans)
  const SNAP_PASS_1 = 0.05;  // 50mm — endpoints that are clearly the same point
  const SNAP_PASS_2 = 0.30;  // 300mm — repair orphan endpoints not snapped in Pass 1
  const MAX_SHIFT = 0.40;    // 400mm — max origin movement per wall

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  if (walls.length < 2) return;

  // Compute endpoints for all walls
  const wallData = [];
  for (const wall of walls) {
    const dir = canonicalWallDirection(wall);
    if (!dir) continue;
    const len = canonicalWallLength(wall);
    const o = wall.placement?.origin;
    if (!o || len <= 0) continue;
    const start = vecAdd(o, vecScale(dir, -len / 2));
    const end = vecAdd(o, vecScale(dir, len / 2));
    wallData.push({ wall, dir, len, start, end });
  }

  // Collect all endpoints
  const endpoints = [];
  for (let i = 0; i < wallData.length; i++) {
    endpoints.push({ wallIdx: i, which: 'start', pt: wallData[i].start });
    endpoints.push({ wallIdx: i, which: 'end', pt: wallData[i].end });
  }

  let totalSnapped = 0;
  let totalSkippedOverCap = 0;
  let pass1Snapped = 0;
  let pass2Snapped = 0;

  // Track which endpoints have been snapped (by index)
  const alreadySnapped = new Set();

  // Run a snapping pass at the given radius, only on un-snapped endpoints
  function runSnapPass(radius, passName) {
    const parent = endpoints.map((_, i) => i);
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(a, b) { parent[find(a)] = find(b); }

    for (let i = 0; i < endpoints.length; i++) {
      for (let j = i + 1; j < endpoints.length; j++) {
        // In Pass 2, skip pairs where both are already snapped
        if (passName === 'pass2' && alreadySnapped.has(i) && alreadySnapped.has(j)) continue;
        if (vecDist(endpoints[i].pt, endpoints[j].pt) < radius) {
          union(i, j);
        }
      }
    }

    const clusters = new Map();
    for (let i = 0; i < endpoints.length; i++) {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(i);
    }

    let passSnapped = 0;

    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      // In Pass 2, skip clusters where all members are already snapped
      if (passName === 'pass2' && members.every(m => alreadySnapped.has(m))) continue;

      const centroid = { x: 0, y: 0, z: 0 };
      for (const idx of members) {
        centroid.x += endpoints[idx].pt.x;
        centroid.y += endpoints[idx].pt.y;
        centroid.z += endpoints[idx].pt.z;
      }
      centroid.x /= members.length;
      centroid.y /= members.length;
      centroid.z /= members.length;

      for (const idx of members) {
        if (alreadySnapped.has(idx)) continue; // Don't re-snap

        const ep = endpoints[idx];
        const wd = wallData[ep.wallIdx];
        const wall = wd.wall;
        const dir = wd.dir;

        const delta = vecSub(centroid, ep.pt);
        const alongDir = vecDot(delta, dir);

        const originShift = vecScale(delta, 0.5);
        const shiftMag = vecLen(originShift);
        if (shiftMag > MAX_SHIFT) {
          totalSkippedOverCap++;
          if (!wall.properties) wall.properties = {};
          wall.properties._endpointSnapSkipped = true;
          continue;
        }

        const o = wall.placement.origin;
        o.x += originShift.x;
        o.y += originShift.y;
        o.z += originShift.z;

        // Propagate Z shift to child openings hosted on this wall
        if (Math.abs(originShift.z) > 1e-6) {
          const wallId = wall.element_key || wall.id;
          for (const el of css.elements) {
            if (el.properties?.hostWallKey !== wallId) continue;
            if (el.placement?.origin) el.placement.origin.z += originShift.z;
          }
        }

        const lenChange = (ep.which === 'start') ? -alongDir : alongDir;
        const newLen = wd.len + lenChange;
        if (newLen > 0.01) {
          setCanonicalWallLength(wall, newLen);
          wd.len = newLen;
        }

        ep.pt = { ...centroid };
        alreadySnapped.add(idx);
        passSnapped++;
        totalSnapped++;
      }
    }

    return passSnapped;
  }

  // Pass 1: High-confidence snap at 50mm
  pass1Snapped = runSnapPass(SNAP_PASS_1, 'pass1');

  // Pass 2: Repair orphans at 150mm (only endpoints not already snapped)
  pass2Snapped = runSnapPass(SNAP_PASS_2, 'pass2');

  if (!css.metadata) css.metadata = {};
  css.metadata.endpointSnapping = {
    snappedPairs: totalSnapped,
    pass1Snapped,
    pass2Snapped,
    skippedOverCap: totalSkippedOverCap,
    wallCount: walls.length,
    snapRadii: { pass1: SNAP_PASS_1, pass2: SNAP_PASS_2 },
    maxShift: MAX_SHIFT
  };
  if (totalSnapped > 0) {
    console.log(`snapWallEndpoints: Pass 1 (${SNAP_PASS_1 * 1000}mm) snapped ${pass1Snapped}, Pass 2 (${SNAP_PASS_2 * 1000}mm) snapped ${pass2Snapped}, skipped ${totalSkippedOverCap}`);
  }
}

/**
 * Parametric roof height derivation — ensures roof slabs sit at the top of walls.
 * Uses median of top-3 tallest walls per storey to avoid LLM outliers.
 * Snaps whenever deviation > 1mm — catches both gross misplacements and
 * sub-200mm "ghosting gaps" that cause visual artifacts in the viewer.
 */
function deriveRoofElevation(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const roofSlabs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' && e.properties?.slabType === 'ROOF'
  );

  if (walls.length === 0 || roofSlabs.length === 0) return;

  // Group walls by container, preferring external walls
  const extWallsByContainer = new Map();
  const allWallsByContainer = new Map();
  for (const wall of walls) {
    const container = wall.container || '_default';
    if (!allWallsByContainer.has(container)) allWallsByContainer.set(container, []);
    allWallsByContainer.get(container).push(wall);
    if (wall.properties?.isExternal) {
      if (!extWallsByContainer.has(container)) extWallsByContainer.set(container, []);
      extWallsByContainer.get(container).push(wall);
    }
  }

  let adjusted = 0;

  for (const slab of roofSlabs) {
    const container = slab.container || '_default';
    // Prefer external walls; fall back to all walls filtered against outlier heights
    let containerWalls = extWallsByContainer.get(container);
    if (!containerWalls) {
      const allWalls = allWallsByContainer.get(container) || [];
      if (allWalls.length > 2) {
        // Filter out interior walls taller than 1.5x median to prevent them pulling roof Z up
        const heights = allWalls.map(w => w.geometry?.depth || 0).sort((a, b) => a - b);
        const medianH = heights[Math.floor(heights.length / 2)];
        containerWalls = allWalls.filter(w => (w.geometry?.depth || 0) <= medianH * 1.5);
      } else {
        containerWalls = allWalls;
      }
    }
    if (!containerWalls || containerWalls.length === 0) continue;

    // Compute wall tops: origin.z + depth (height)
    const wallTops = [];
    for (const wall of containerWalls) {
      const oz = wall.placement?.origin?.z;
      const depth = wall.geometry?.depth;
      if (typeof oz === 'number' && typeof depth === 'number' && depth > 0) {
        wallTops.push(oz + depth);
      }
    }

    if (wallTops.length === 0) continue;

    // Median of top-3 tallest walls (or all if fewer than 3)
    wallTops.sort((a, b) => b - a);
    const topN = wallTops.slice(0, Math.min(3, wallTops.length));
    const medianIdx = Math.floor(topN.length / 2);
    const derivedZ = topN.length % 2 === 1
      ? topN[medianIdx]
      : (topN[medianIdx - 1] + topN[medianIdx]) / 2;

    // Snap whenever not already exact (> 1mm) — catches ghosting gaps AND gross misplacements
    const currentZ = slab.placement?.origin?.z;
    if (typeof currentZ !== 'number') continue;

    if (Math.abs(currentZ - derivedZ) > 0.001) {
      slab.placement.origin.z = derivedZ;
      if (!slab.properties) slab.properties = {};
      slab.properties._heightChainAdjusted = true;
      slab.properties._derivedFromWallHeight = Math.round(derivedZ * 1000) / 1000;
      slab.properties._previousZ = Math.round(currentZ * 1000) / 1000;
      adjusted++;
    }
  }

  if (adjusted > 0) {
    console.log(`deriveRoofElevation: adjusted ${adjusted} roof slab(s) to match wall heights`);
  }
}

/**
 * Snap floor slabs to wall bases — if a floor slab is within 100mm of a wall's
 * base Z, snap it exactly. Prevents "light leaks" between floor and walls.
 */
function snapSlabsToWallBases(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const floorSlabs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' &&
    (e.properties?.slabType === 'FLOOR' || !e.properties?.slabType)
  );

  if (walls.length === 0 || floorSlabs.length === 0) return;

  // Group wall base Z values by container
  const wallBasesByContainer = new Map();
  for (const wall of walls) {
    const container = wall.container || '_default';
    const baseZ = wall.placement?.origin?.z;
    if (typeof baseZ !== 'number') continue;
    if (!wallBasesByContainer.has(container)) wallBasesByContainer.set(container, []);
    wallBasesByContainer.get(container).push(baseZ);
  }

  let snapped = 0;

  for (const slab of floorSlabs) {
    const container = slab.container || '_default';
    const bases = wallBasesByContainer.get(container);
    if (!bases || bases.length === 0) continue;

    const slabZ = slab.placement?.origin?.z;
    if (typeof slabZ !== 'number') continue;

    // Find median wall base Z for this storey
    const sorted = [...bases].sort((a, b) => a - b);
    const medianBase = sorted[Math.floor(sorted.length / 2)];

    // Snap if within 100mm
    if (Math.abs(slabZ - medianBase) <= 0.10 && Math.abs(slabZ - medianBase) > 0.001) {
      slab.placement.origin.z = medianBase;
      if (!slab.properties) slab.properties = {};
      slab.properties._wallBaseSnapped = true;
      snapped++;
    }
  }

  if (snapped > 0) {
    console.log(`snapSlabsToWallBases: snapped ${snapped} floor slab(s) to wall base Z`);
  }
}

// ============================================================================
// WALL-TO-FLOOR Z SNAP
// Ensures wall bases sit exactly on their storey floor elevation — closes the
// visible gap between interior walls and the floor slab.
// ============================================================================

function snapWallsToStoreyFloor(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const levels = css.levelsOrSegments || [];
  if (levels.length === 0) return;

  // Build storey elevation map from levels
  const storeyElevation = new Map();
  for (const level of levels) {
    storeyElevation.set(level.id, level.elevation_m || 0);
  }

  // Also derive floor-slab top Z per container for higher accuracy
  const slabTopByContainer = new Map();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'SLAB') continue;
    if (e.properties?.slabType && e.properties.slabType !== 'FLOOR') continue;
    const c = e.container || '_default';
    const z = e.placement?.origin?.z;
    const d = e.geometry?.depth || 0.2;
    if (typeof z === 'number') {
      const top = z + d;
      if (!slabTopByContainer.has(c) || top > slabTopByContainer.get(c)) {
        slabTopByContainer.set(c, top);
      }
    }
  }

  let snapped = 0;

  for (const elem of css.elements) {
    const t = (elem.type || '').toUpperCase();
    if (t !== 'WALL') continue;

    const o = elem.placement?.origin;
    if (!o || typeof o.z !== 'number') continue;

    const container = elem.container || '_default';

    // Prefer slab-top Z, fall back to storey elevation
    let targetZ = slabTopByContainer.get(container);
    if (targetZ === undefined) targetZ = storeyElevation.get(container);
    if (targetZ === undefined) continue;

    // Snap if within 500mm — wall should sit on its storey floor
    const gap = Math.abs(o.z - targetZ);
    if (gap > 0.001 && gap <= 0.5) {
      o.z = targetZ;
      snapped++;
    }
  }

  if (snapped > 0) {
    console.log(`snapWallsToStoreyFloor: snapped ${snapped} wall(s) to storey floor elevation`);
  }
}

// ============================================================================
// WALL-SLAB ALIGNMENT (Phase 2G)
// ============================================================================

/**
 * Extend slab footprints to align with outermost wall endpoints.
 */
function alignSlabsToWalls(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const slabs = css.elements.filter(e => (e.type || '').toUpperCase() === 'SLAB' && !e.properties?.isFallbackEnvelope);
  if (walls.length === 0 || slabs.length === 0) return;

  // Group walls by container so each slab aligns to its own storey's walls
  const wallsByContainer = new Map();
  for (const wall of walls) {
    const c = wall.container || '_default';
    if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
    wallsByContainer.get(c).push(wall);
  }

  const OVERHANG = 0.05;
  let alignedCount = 0;

  for (const slab of slabs) {
    const p = slab.geometry?.profile;
    const o = slab.placement?.origin;
    if (!p || !o) continue;

    const container = slab.container || '_default';
    const containerWalls = wallsByContainer.get(container);
    if (!containerWalls || containerWalls.length === 0) continue; // no walls in this container — skip slab

    // Compute wall bbox for this container only
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const wall of containerWalls) {
      const dir = canonicalWallDirection(wall);
      if (!dir) continue;
      const len = canonicalWallLength(wall);
      const wo = wall.placement?.origin;
      if (!wo) continue;
      const start = vecAdd(wo, vecScale(dir, -len / 2));
      const end = vecAdd(wo, vecScale(dir, len / 2));
      minX = Math.min(minX, start.x, end.x);
      maxX = Math.max(maxX, start.x, end.x);
      minY = Math.min(minY, start.y, end.y);
      maxY = Math.max(maxY, start.y, end.y);
    }
    if (!isFinite(minX)) continue;

    const wallExtentX = (maxX - minX) + 2 * OVERHANG;
    const wallExtentY = (maxY - minY) + 2 * OVERHANG;
    const wallCenterX = (minX + maxX) / 2;
    const wallCenterY = (minY + maxY) / 2;

    const slabW = p.width || 0;
    const slabH = p.height || 0;

    // Clip slabs to wall footprint — both undersized AND oversized slabs get corrected
    const needsAlign = (
      Math.abs(slabW - wallExtentX) > 0.1 ||
      Math.abs(slabH - wallExtentY) > 0.1 ||
      Math.abs(o.x - wallCenterX) > 0.1 ||
      Math.abs(o.y - wallCenterY) > 0.1
    );
    if (needsAlign) {
      p.width = wallExtentX;
      p.height = wallExtentY;
      o.x = wallCenterX;
      o.y = wallCenterY;
      alignedCount++;
    }
  }

  if (alignedCount > 0) {
    console.log(`alignSlabsToWalls: aligned ${alignedCount} slab(s) to container wall footprint`);
  }
}

// ============================================================================
// TUNNEL ENDPOINT SNAPPING
// Ensures adjacent tunnel segment shell pieces share exact endpoint coordinates,
// eliminating "not watertight" gaps between pieces.
// ============================================================================

/**
 * Snap tunnel segment/shell piece endpoints within 150mm to exact shared coords.
 * For each pair of adjacent segments, if exit[A] ≈ entry[B] (within 150mm),
 * both endpoints are moved to their midpoint. Origin is adjusted accordingly.
 */
/**
 * Merge tunnel segments shorter than MIN_SEGMENT_LENGTH into their longest adjacent neighbor.
 * Short stubs (< 0.5m) cause snap failures and skeleton fragmentation — absorb them into
 * the longest connected neighbor to preserve path continuity without collapsing any geometry.
 */
export function mergeShortTunnelSegments(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;

  const MIN_LENGTH = 0.5; // metres — stubs shorter than this are merged
  const CLOSE_THRESHOLD = 0.2; // endpoint proximity threshold for "connected"

  // Only consider non-decomposed parent tunnel segments
  const tunnelSegs = css.elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    return t === 'TUNNEL_SEGMENT'
      && e.placement?.origin && e.placement?.axis
      && (e.geometry?.depth || 0) > 0;
  });

  const vecNorm = (v) => {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    return len > 1e-10 ? { x: v.x / len, y: v.y / len, z: v.z / len } : null;
  };
  const vecDist3 = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
  const vecAddS = (o, d, s) => ({ x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s });

  let merged = 0;

  for (const seg of tunnelSegs) {
    const depth = seg.geometry.depth;
    if (depth >= MIN_LENGTH || seg._mergedIntoNeighbor) continue;

    const segAxis = vecNorm(seg.placement.axis);
    if (!segAxis) continue;

    const segEntry = vecAddS(seg.placement.origin, segAxis, -depth / 2);
    const segExit  = vecAddS(seg.placement.origin, segAxis,  depth / 2);

    // Find best neighbor: must be longer, adjacent (within CLOSE_THRESHOLD), not already merged
    let bestNeighbor = null;
    let bestLen = -1;
    let bestExtension = 0;
    let bestExtendAtStart = false;

    for (const candidate of tunnelSegs) {
      if (candidate === seg || candidate._mergedIntoNeighbor) continue;
      const cDepth = candidate.geometry.depth;
      if (cDepth <= depth) continue; // only absorb into something longer

      const cAxis = vecNorm(candidate.placement.axis);
      if (!cAxis) continue;
      const cEntry = vecAddS(candidate.placement.origin, cAxis, -cDepth / 2);
      const cExit  = vecAddS(candidate.placement.origin, cAxis,  cDepth / 2);

      // seg.exit ≈ candidate.entry → extend candidate backward
      const d1 = vecDist3(segExit, cEntry);
      // seg.entry ≈ candidate.exit → extend candidate forward
      const d2 = vecDist3(segEntry, cExit);
      // also check reversed-orientation junctions
      const d3 = vecDist3(segExit, cExit);
      const d4 = vecDist3(segEntry, cEntry);

      const minDist = Math.min(d1, d2, d3, d4);
      if (minDist >= CLOSE_THRESHOLD || cDepth <= bestLen) continue;

      bestLen = cDepth;
      bestNeighbor = { elem: candidate, axis: cAxis, depth: cDepth, entry: cEntry, exit: cExit };
      if (d1 <= minDist + 1e-6) {
        // Extend candidate start: add depth to the entry side
        bestExtension = depth + d1;
        bestExtendAtStart = true;
      } else if (d2 <= minDist + 1e-6) {
        // Extend candidate end: add depth to the exit side
        bestExtension = depth + d2;
        bestExtendAtStart = false;
      } else {
        // Degenerate overlap case — just extend by stub depth
        bestExtension = depth;
        bestExtendAtStart = d3 < d4;
      }
    }

    if (!bestNeighbor) continue;

    const n = bestNeighbor;
    if (bestExtendAtStart) {
      // Extend neighbor backward: shift origin back, increase depth
      n.elem.geometry.depth += bestExtension;
      n.elem.placement.origin.x -= n.axis.x * (bestExtension / 2);
      n.elem.placement.origin.y -= n.axis.y * (bestExtension / 2);
      n.elem.placement.origin.z -= n.axis.z * (bestExtension / 2);
    } else {
      // Extend neighbor forward: shift origin forward, increase depth
      n.elem.geometry.depth += bestExtension;
      n.elem.placement.origin.x += n.axis.x * (bestExtension / 2);
      n.elem.placement.origin.y += n.axis.y * (bestExtension / 2);
      n.elem.placement.origin.z += n.axis.z * (bestExtension / 2);
    }

    seg._mergedIntoNeighbor = true;
    merged++;
  }

  if (merged > 0) {
    css.elements = css.elements.filter(e => !e._mergedIntoNeighbor);
    console.log(`mergeShortTunnelSegments: absorbed ${merged} stub(s) < ${MIN_LENGTH}m into longer neighbors`);
  }
  if (!css.metadata) css.metadata = {};
  css.metadata.shortSegmentsMerged = merged;
}


function snapTunnelSegmentEndpoints(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;

  const SNAP_RADIUS = 0.05; // 50mm — high-precision engineering-grade snap for tunnel nodes
  const MAX_ADJUST = 0.20;  // 200mm max origin shift to prevent mangling long elements

  // Collect all tunnel segments and shell pieces with valid geometry
  const segs = css.elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    return (t === 'TUNNEL_SEGMENT' || e.properties?.shellPiece) &&
           e.placement?.origin && e.placement?.axis && (e.geometry?.depth || 0) > 0;
  });
  if (segs.length < 2) return;

  // Pre-compute entry/exit endpoints for each segment
  const segData = segs.map(elem => {
    const o = elem.placement.origin;
    const axis = vecNormalize(elem.placement.axis);
    if (!axis) return null;
    const depth = elem.geometry.depth;
    const entry = vecAdd(o, vecScale(axis, -depth / 2));
    const exit  = vecAdd(o, vecScale(axis,  depth / 2));
    return { elem, axis, depth, entry, exit };
  }).filter(Boolean);

  let snapped = 0;

  // O(n²) pair check — tunnel models rarely exceed ~100 segments, so this is fine
  for (let i = 0; i < segData.length; i++) {
    for (let j = i + 1; j < segData.length; j++) {
      const a = segData[i];
      const b = segData[j];

      // Same element — skip
      if (a.elem === b.elem) continue;

      // Only snap between same shell-piece role so we don't cross LEFT_WALL with ROOF etc.
      const aRole = a.elem.properties?.shellPiece || '_parent';
      const bRole = b.elem.properties?.shellPiece || '_parent';
      if (aRole !== bRole) continue;

      // Check both orientations: exit[a]≈entry[b] and entry[a]≈exit[b]
      const checks = [
        { aEnd: 'exit',  bEnd: 'entry' },
        { aEnd: 'entry', bEnd: 'exit'  },
      ];

      for (const { aEnd, bEnd } of checks) {
        const aPt = a[aEnd];
        const bPt = b[bEnd];
        const dist = vecDist(aPt, bPt);
        if (dist >= SNAP_RADIUS || dist < 1e-6) continue;

        // Snap to midpoint
        const mid = {
          x: (aPt.x + bPt.x) / 2,
          y: (aPt.y + bPt.y) / 2,
          z: (aPt.z + bPt.z) / 2,
        };

        // Adjust a's origin: origin = mid ∓ axis * depth/2
        // exit = origin + axis*(d/2) → origin = mid - axis*(d/2) when aEnd='exit'
        // entry = origin - axis*(d/2) → origin = mid + axis*(d/2) when aEnd='entry'
        const aSign = aEnd === 'exit' ? -1 : 1;
        const newAOrigin = vecAdd(mid, vecScale(a.axis, aSign * a.depth / 2));
        const aShift = vecDist(newAOrigin, a.elem.placement.origin);
        if (aShift <= MAX_ADJUST) {
          a.elem.placement.origin.x = newAOrigin.x;
          a.elem.placement.origin.y = newAOrigin.y;
          a.elem.placement.origin.z = newAOrigin.z;
          a[aEnd] = { ...mid };
          // Recompute the other end to stay consistent
          a[aEnd === 'exit' ? 'entry' : 'exit'] = vecAdd(
            a.elem.placement.origin,
            vecScale(a.axis, (aEnd === 'exit' ? -1 : 1) * a.depth / 2)
          );
        }

        // Adjust b's origin similarly
        const bSign = bEnd === 'exit' ? -1 : 1;
        const newBOrigin = vecAdd(mid, vecScale(b.axis, bSign * b.depth / 2));
        const bShift = vecDist(newBOrigin, b.elem.placement.origin);
        if (bShift <= MAX_ADJUST) {
          b.elem.placement.origin.x = newBOrigin.x;
          b.elem.placement.origin.y = newBOrigin.y;
          b.elem.placement.origin.z = newBOrigin.z;
          b[bEnd] = { ...mid };
          b[bEnd === 'exit' ? 'entry' : 'exit'] = vecAdd(
            b.elem.placement.origin,
            vecScale(b.axis, (bEnd === 'exit' ? -1 : 1) * b.depth / 2)
          );
        }

        snapped++;
        break; // Only one orientation can match per pair
      }
    }
  }

  if (snapped > 0) {
    console.log(`snapTunnelSegmentEndpoints: ${snapped} junction(s) snapped to exact shared coordinates`);
  }
  if (!css.metadata) css.metadata = {};
  css.metadata.tunnelEndpointSnapping = { snapped };
}
