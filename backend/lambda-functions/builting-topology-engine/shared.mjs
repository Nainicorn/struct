/**
 * shared.mjs — Vector math, geometry utilities, and profile generators.
 * Shared between builting-structure and builting-geometry Lambdas.
 */

import { createHash } from 'crypto';

// ============================================================================
// NUMERIC UTILITIES
// ============================================================================

export function safe(val) { const n = Number(val); return isFinite(n) ? n : 0; }
export function clamp(val, max) { return Math.max(-max, Math.min(max, val)); }
export function sanitizeDir(d) {
  d.x = safe(d.x); d.y = safe(d.y); d.z = safe(d.z);
  if (d.x === 0 && d.y === 0 && d.z === 0) d.z = 1;
}

// ============================================================================
// ELEMENT ID GENERATION
// ============================================================================

export function elemId(geometry, placement) {
  const data = JSON.stringify({ geometry, placement });
  return 'elem-' + createHash('sha256').update(data).digest('hex').slice(0, 12);
}

// ============================================================================
// VECTOR MATH
// ============================================================================

export function vecNormalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-12 || !isFinite(len)) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function vecDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

export function vecCross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function vecScale(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }

export function vecAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }

export function vecSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }

export function vecDist(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2); }

export function vecLen(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

export function computeBisectorPlane(dirA, dirB, point) {
  const sum = vecAdd(dirA, dirB);
  const normal = vecNormalize(sum);
  if (!normal) {
    // Opposite directions — bisector is perpendicular to either
    const perp = vecNormalize(dirA);
    return perp ? { normal: perp, point } : null;
  }
  return { normal, point };
}

export function intersectLineWithPlane(lineOrigin, lineDir, planePoint, planeNormal) {
  const denom = vecDot(lineDir, planeNormal);
  if (Math.abs(denom) < 0.01) return null; // parallel
  const diff = vecSub(planePoint, lineOrigin);
  const t = vecDot(diff, planeNormal) / denom;
  return t;
}

// ============================================================================
// CANONICAL WALL HELPERS
// ============================================================================

/**
 * Canonical wall run direction — single source of truth for the horizontal axis
 * a wall runs along. Priority:
 *   1. placement.refDirection (if present and horizontal)
 *   2. properties.wallSide cardinal mapping
 *   3. placement.axis (if clearly horizontal, i.e. |z| < 0.5)
 *   4. Infer from profile: width > height → X, else Y
 *
 * Returns a normalized {x,y,z} vector or null if undetermined.
 * Side-effect: writes back placement.refDirection so downstream is consistent.
 */
export function canonicalWallDirection(wall) {
  // 1. refDirection
  const ref = wall.placement?.refDirection;
  if (ref) {
    const d = vecNormalize(ref);
    if (d && Math.abs(d.z) < 0.5) {
      // Ensure horizontal — zero out z and re-normalize
      const h = vecNormalize({ x: d.x, y: d.y, z: 0 });
      if (h) { _writeBackRefDir(wall, h); return h; }
    }
  }

  // 2. wallSide property
  const side = (wall.properties?.wallSide || '').toUpperCase();
  if (side === 'SOUTH' || side === 'NORTH') { const d = { x: 1, y: 0, z: 0 }; _writeBackRefDir(wall, d); return d; }
  if (side === 'EAST' || side === 'WEST')   { const d = { x: 0, y: 1, z: 0 }; _writeBackRefDir(wall, d); return d; }

  // 3. placement.axis (only if horizontal)
  const ax = wall.placement?.axis;
  if (ax) {
    const n = vecNormalize(ax);
    if (n && Math.abs(n.z) < 0.5) {
      const h = vecNormalize({ x: n.x, y: n.y, z: 0 });
      if (h) { _writeBackRefDir(wall, h); return h; }
    }
  }

  // 4. Infer from profile dimensions
  const p = wall.geometry?.profile;
  if (p) {
    const w = p.width || 0, h = p.height || 0;
    if (w > 0 || h > 0) {
      const d = (w >= h) ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      _writeBackRefDir(wall, d);
      return d;
    }
  }

  return null;
}

function _writeBackRefDir(wall, dir) {
  if (!wall.placement) wall.placement = {};
  wall.placement.refDirection = { x: dir.x, y: dir.y, z: dir.z };
}

/**
 * Canonical wall run length — the horizontal extent along canonicalWallDirection.
 * Returns the length in meters.
 */
export function canonicalWallLength(wall) {
  const p = wall.geometry?.profile || {};
  const w = p.width || 0, h = p.height || 0;

  // If refDirection was resolved, use it to pick the aligned dimension
  const dir = canonicalWallDirection(wall);
  if (dir && w > 0 && h > 0) {
    // If direction is primarily X-aligned, width is length when width was the X dimension
    // Convention: width = dimension along refDirection, height = thickness
    // But we need to check if this is already consistent
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio >= 1.15) {
      // Clear winner — longer dimension is length
      return Math.max(w, h);
    }
    // Ambiguous — use width as length by convention (matches extract convention)
    if (!wall.properties) wall.properties = {};
    wall.properties._ambiguousProfile = true;
    return w;
  }
  return w || h || wall.geometry?.depth || 1;
}

/**
 * Canonical wall thickness — the perpendicular (short) dimension.
 */
export function canonicalWallThickness(wall) {
  const p = wall.geometry?.profile || {};
  const w = p.width || 0, h = p.height || 0;
  if (w > 0 && h > 0) {
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio >= 1.15) return Math.min(w, h);
    // Ambiguous — height = thickness by convention
    return h;
  }
  return w || h || 0.2;
}

/**
 * Set wall run length — updates the correct profile dimension.
 */
export function setCanonicalWallLength(wall, len) {
  const p = wall.geometry?.profile;
  if (!p) return;
  const w = p.width || 0, h = p.height || 0;
  const ratio = (w > 0 && h > 0) ? Math.max(w, h) / Math.min(w, h) : 999;
  if (ratio < 1.15) {
    p.width = len; // ambiguous — width = length by convention
  } else if (w >= h) {
    p.width = len;
  } else {
    p.height = len;
  }
}

// ============================================================================
// PROFILE GENERATORS
// ============================================================================

export function generateChamferedRectProfile(halfW, halfH, chamferRatio = 0.3) {
  const chamfer = Math.min(halfW, halfH) * chamferRatio;
  return [
    { x: +(halfW - chamfer).toFixed(4), y: +halfH.toFixed(4) },
    { x: +halfW.toFixed(4), y: +(halfH - chamfer).toFixed(4) },
    { x: +halfW.toFixed(4), y: +(-(halfH - chamfer)).toFixed(4) },
    { x: +(halfW - chamfer).toFixed(4), y: +(-halfH).toFixed(4) },
    { x: +(-(halfW - chamfer)).toFixed(4), y: +(-halfH).toFixed(4) },
    { x: +(-halfW).toFixed(4), y: +(-(halfH - chamfer)).toFixed(4) },
    { x: +(-halfW).toFixed(4), y: +(halfH - chamfer).toFixed(4) },
    { x: +(-(halfW - chamfer)).toFixed(4), y: +halfH.toFixed(4) },
  ];
}

export function generateCirclePoints(radius, n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    points.push({ x: +(radius * Math.cos(angle)).toFixed(4), y: +(radius * Math.sin(angle)).toFixed(4) });
  }
  return points;
}

export function generateHorseshoePoints(w, h, archSegs) {
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

// ============================================================================
// TUNNEL FRAME BUILDER
// ============================================================================

/**
 * Builds a stable orthonormal local frame for a tunnel segment.
 * Returns { tangent, lateral, up } or null if the frame cannot be computed.
 *
 * tangent = normalized direction from start to end (tunnel axis)
 * lateral = horizontal perpendicular (left-to-right)
 * up      = vertical perpendicular (floor-to-roof)
 *
 * preferredUp defaults to global Z. If the tangent is nearly parallel to
 * preferredUp, falls back to global X then global Y.
 */
export function buildTunnelFrame(startPoint, endPoint, preferredUp) {
  const raw = vecSub(endPoint, startPoint);
  const tangent = vecNormalize(raw);
  if (!tangent) return null;

  // Choose an up candidate that isn't parallel to tangent
  const UP_CANDIDATES = [
    preferredUp || { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 0, z: 0 }
  ];

  let lateral = null;
  let up = null;

  for (const candidate of UP_CANDIDATES) {
    const norm = vecNormalize(candidate);
    if (!norm) continue;
    if (Math.abs(vecDot(tangent, norm)) > 0.95) continue;

    lateral = vecNormalize(vecCross(tangent, norm));
    if (!lateral) continue;

    up = vecNormalize(vecCross(lateral, tangent));
    if (up) break;

    lateral = null;
  }

  if (!tangent || !lateral || !up) return null;

  return { tangent, lateral, up };
}

/**
 * Validates whether a tunnel frame is geometrically usable.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateTunnelFrame(frame) {
  if (!frame) return { valid: false, reason: 'null_frame' };
  if (!frame.tangent || !frame.lateral || !frame.up) return { valid: false, reason: 'missing_axis' };

  // Check orthogonality
  const tl = Math.abs(vecDot(frame.tangent, frame.lateral));
  const tu = Math.abs(vecDot(frame.tangent, frame.up));
  const lu = Math.abs(vecDot(frame.lateral, frame.up));
  if (tl > 0.01 || tu > 0.01 || lu > 0.01) return { valid: false, reason: 'non_orthogonal' };

  // Check unit length
  const tLen = vecLen(frame.tangent);
  const lLen = vecLen(frame.lateral);
  const uLen = vecLen(frame.up);
  if (Math.abs(tLen - 1) > 0.01 || Math.abs(lLen - 1) > 0.01 || Math.abs(uLen - 1) > 0.01) {
    return { valid: false, reason: 'non_unit_length' };
  }

  return { valid: true };
}

// ---- Curved shell arc profile generators ----
// All profiles are in the local cross-section plane (local X=side, local Y=up)
// centered at the tunnel axis origin. Each returns a closed polygon (ARBITRARY profile).

export function generateLeftWallArcProfile(R, t, segments) {
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

export function generateRightWallArcProfile(R, t, segments) {
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

// ============================================================================
// HOST INTERIOR FRAME — universal host-local coordinate helper
// ============================================================================

/**
 * Computes interior floor/ceiling/width from any host element's placement and profile.
 * Works for tunnels (center-origin), buildings (floor-origin), rooms, containers.
 * VentSim convention: origin = center of cross-section, so floor = origin.z - h/2.
 * Building convention: origin = floor level, so floor = origin.z.
 */
export function getHostInteriorFrame(host) {
  const origin = host.placement?.origin || { x: 0, y: 0, z: 0 };
  const h = host.geometry?.profile?.height || 0;
  const w = host.geometry?.profile?.width || 0;
  const t = host.properties?.shellThickness_m || host.geometry?.profile?.wallThickness || 0;

  // Detect origin convention: tunnel segments use center-origin, buildings use floor-origin.
  // Tunnel segments have type TUNNEL_SEGMENT; everything else assumes floor-origin.
  const isCenterOrigin = (host.type || '').toUpperCase() === 'TUNNEL_SEGMENT';

  let floorZ, ceilZ;
  if (isCenterOrigin) {
    floorZ = origin.z - h / 2;
    ceilZ = origin.z + h / 2;
  } else {
    floorZ = origin.z;
    ceilZ = origin.z + h;
  }

  const innerFloorZ = floorZ + t;
  const innerCeilZ = ceilZ - t;
  const innerWidth = w - 2 * t;
  const innerHeight = innerCeilZ - innerFloorZ;

  return { floorZ, ceilZ, innerFloorZ, innerCeilZ, width: w, innerWidth, height: h, innerHeight, thickness: t, origin };
}


export function generateRoofArcProfile(halfW, wallH, archHeight, t, segments) {
  // Horseshoe roof arch: outer arc from π→0 (left→top→right) at y=wallH, inner arc reversed
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
