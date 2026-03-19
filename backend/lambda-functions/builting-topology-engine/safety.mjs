/**
 * CSS Validation + Safety Checks for GeometryBuild Lambda.
 * Extracted from builting-transform handler lines 127-228.
 */

/**
 * Validates CSS elements for structural issues:
 * - Duplicate element_keys
 * - NaN/Inf placements
 * - Invalid depths
 */
export function validateCSSElements(css) {
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
  return cssIssues;
}

/**
 * Safety checks: element count limits, coordinate bounds, overlap detection, model extent.
 * Returns { safetyWarnings, cssIssues (appended), modelExtent, duplicatePositionCount, outOfBoundsCount }.
 */
export function runSafetyChecks(css, cssIssues) {
  const safetyWarnings = [];

  // 9A: Element count limits — prevent runaway generation
  // Smart truncation: prioritize architectural envelope (walls, slabs, doors, windows, spaces)
  // over repetitive structural grid elements (columns, beams) when over limit
  const MAX_ELEMENTS = 5000;
  if (css.elements.length > MAX_ELEMENTS) {
    safetyWarnings.push(`CRITICAL: Element count ${css.elements.length} exceeds limit ${MAX_ELEMENTS} — smart truncating`);
    console.warn(`Safety: smart-truncating ${css.elements.length} elements to ${MAX_ELEMENTS}`);

    // Priority tiers: lower number = higher priority (kept first)
    const PRIORITY = { WALL: 0, SLAB: 0, DOOR: 1, WINDOW: 1, SPACE: 1, STAIR: 2, RAMP: 2,
      TUNNEL_SEGMENT: 0, COLUMN: 3, BEAM: 3, EQUIPMENT: 4, PROXY: 5 };
    const prioritized = css.elements.map((e, i) => ({ e, priority: PRIORITY[e.type] ?? 4, index: i }));
    prioritized.sort((a, b) => a.priority - b.priority || a.index - b.index);
    css.elements = prioritized.slice(0, MAX_ELEMENTS).map(p => p.e);

    const kept = {};
    for (const e of css.elements) { kept[e.type] = (kept[e.type] || 0) + 1; }
    console.log(`Smart truncation kept: ${JSON.stringify(kept)}`);
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

  const modelExtent = Number.isFinite(modelExtentX) ? {
    x: Math.round(modelExtentX * 100) / 100,
    y: Math.round(modelExtentY * 100) / 100,
    z: Math.round(modelExtentZ * 100) / 100,
    elementCount: css.elements.length,
    duplicatePositions: duplicatePositionCount,
    outOfBounds: outOfBoundsCount
  } : null;

  return { safetyWarnings, cssIssues, modelExtent, duplicatePositionCount, outOfBoundsCount };
}
