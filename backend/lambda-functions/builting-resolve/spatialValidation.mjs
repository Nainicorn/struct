/**
 * spatialValidation.mjs — Spatial schema validation pass for the Resolve Lambda.
 *
 * Runs AFTER normalizeClaims, BEFORE resolveClaims.
 *
 * Three checks, in order:
 *  1. Storey validity      — every STOREY-type level must have numeric elevation_m
 *                            and height_m > 0. SEGMENT-type levels must have
 *                            numeric startChainage_m and endChainage_m.
 *                            Invalid levels are marked status='rejected'.
 *
 *  2. Element containment  — every wall / slab / column / MEP element must
 *                            reference a container ID that belongs to a valid
 *                            level. Orphaned elements have confidence clamped to
 *                            0.1 and attributes.containment_error = true.
 *
 *  3. Wall geometry        — every wall_candidate must have: placement.origin
 *                            (start point), profile.width > 0 (end point),
 *                            depth > 0 (height), and profile.height > 0
 *                            (thickness). Incomplete walls are marked
 *                            status='rejected' so resolveClaims drops them.
 *
 * Returns { validatedDoc, validationSummary }.
 * The caller attaches validationSummary to canonical_observed.json as
 * a top-level key so topology-engine can inspect dropped/flagged data.
 */

// Claim kinds that must reference a valid container (storey or segment).
const CONTAINER_BOUND_KINDS = new Set([
  'wall_candidate',
  'slab_candidate',
  'column_candidate',
  'equipment_instance',
]);

/**
 * Validate spatial schema on the normalized claims document.
 *
 * @param {object} normalizedDoc - Output of normalizeClaims (deep-cloned internally).
 * @returns {{ validatedDoc: object, validationSummary: object }}
 */
export function validateSpatialSchema(normalizedDoc) {
  // normalizeClaims already returns a deep clone — mutate safely.
  const doc = normalizedDoc;
  const claims = doc.claims || [];
  const domain = doc.domain || 'UNKNOWN';

  const rejectedStoreys = [];
  const orphanedElements = [];
  const rejectedWalls = [];
  const warnings = [];

  // ── 1. Storey Validation ─────────────────────────────────────────────────
  const levelClaims = claims.filter(c => c.kind === 'level_definition');
  const validContainerIds = new Set(); // all levels that passed validation

  for (const c of levelClaims) {
    const attrs = c.attributes || {};
    const storeyId = c.subject_local_id;
    const segType = attrs.type || 'STOREY';
    const missing = [];

    if (segType === 'STOREY') {
      // IfcBuildingStorey: needs numeric elevation (any value) and positive height.
      if (typeof attrs.elevation_m !== 'number' || isNaN(attrs.elevation_m)) {
        missing.push('elevation_m');
      }
      if (typeof attrs.height_m !== 'number' || isNaN(attrs.height_m) || attrs.height_m <= 0) {
        missing.push('height_m');
      }
    } else if (segType === 'SEGMENT') {
      // Tunnel alignment segment: needs numeric chainage bounds.
      if (typeof attrs.startChainage_m !== 'number' || isNaN(attrs.startChainage_m)) {
        missing.push('startChainage_m');
      }
      if (typeof attrs.endChainage_m !== 'number' || isNaN(attrs.endChainage_m)) {
        missing.push('endChainage_m');
      }
    }
    // ZONE type: register as valid without extra checks.

    if (missing.length > 0) {
      const msg = `Storey "${storeyId}" (${segType}) rejected — missing or invalid: ${missing.join(', ')}`;
      console.warn(`[spatial-validation] ${msg}`);
      warnings.push(msg);
      rejectedStoreys.push({
        storeyId,
        storeyName: attrs.name || storeyId,
        segType,
        missing,
      });
      c.status = 'rejected';
      c._spatial_rejection = `invalid_storey: ${missing.join(', ')}`;
    } else {
      validContainerIds.add(storeyId);
    }
  }

  // ── 2. Element Containment Check ─────────────────────────────────────────
  // Only check non-rejected claims whose kind must live inside a storey/segment.
  const containmentClaims = claims.filter(
    c => CONTAINER_BOUND_KINDS.has(c.kind) && c.status !== 'rejected'
  );

  for (const c of containmentClaims) {
    const attrs = c.attributes || {};
    const container = attrs.container;

    if (!container || !validContainerIds.has(container)) {
      const msg = `Element "${c.subject_local_id}" (${c.kind}) orphaned — container "${container ?? 'null'}" not found in valid storeys`;
      console.warn(`[spatial-validation] ${msg}`);
      warnings.push(msg);
      orphanedElements.push({
        elementId: c.subject_local_id,
        kind: c.kind,
        name: attrs.name || attrs.element_key || c.subject_local_id,
        container: container ?? null,
      });
      // Flag but keep in pipeline — confidence penalty signals to downstream.
      c.confidence = Math.min(c.confidence, 0.1);
      c.attributes.containment_error = true;
    }
  }

  // ── 3. Wall Geometry Completeness ────────────────────────────────────────
  // Check non-rejected wall claims for the four required geometry fields.
  const wallClaims = claims.filter(
    c => c.kind === 'wall_candidate' && c.status !== 'rejected'
  );

  for (const c of wallClaims) {
    const attrs = c.attributes || {};
    const placement = attrs.placement;
    const geometry = attrs.geometry;
    const missing = [];

    // Start point — placement.origin must exist.
    if (!placement?.origin) {
      missing.push('start_point (placement.origin)');
    }

    // End point — profile.width encodes the wall run length; must be > 0.
    // (End point = origin + refDirection × profile.width in IFC extrusion model.)
    const profileWidth = geometry?.profile?.width;
    if (typeof profileWidth !== 'number' || profileWidth <= 0) {
      missing.push('end_point (geometry.profile.width > 0)');
    }

    // Height — geometry.depth is the extrusion depth (wall height); must be > 0.
    const depth = geometry?.depth;
    if (typeof depth !== 'number' || depth <= 0) {
      missing.push('height (geometry.depth > 0)');
    }

    // Thickness — profile.height is the wall's cross-section thickness; must be > 0.
    const profileHeight = geometry?.profile?.height;
    if (typeof profileHeight !== 'number' || profileHeight <= 0) {
      missing.push('thickness (geometry.profile.height > 0)');
    }

    if (missing.length > 0) {
      const msg = `Wall "${c.subject_local_id}" removed — incomplete geometry: ${missing.join(', ')}`;
      console.warn(`[spatial-validation] ${msg}`);
      warnings.push(msg);
      rejectedWalls.push({
        elementId: c.subject_local_id,
        name: attrs.name || attrs.element_key || c.subject_local_id,
        missing,
      });
      c.status = 'rejected';
      c._spatial_rejection = `incomplete_wall_geometry: ${missing.join(', ')}`;
    }
  }

  // ── Build summary ─────────────────────────────────────────────────────────
  const validationSummary = {
    ran: true,
    timestamp: new Date().toISOString(),
    domain,
    storeys: {
      total: levelClaims.length,
      valid: validContainerIds.size,
      rejected: rejectedStoreys,
    },
    containment: {
      checkedKinds: [...CONTAINER_BOUND_KINDS],
      orphanedCount: orphanedElements.length,
      orphaned: orphanedElements,
    },
    wallGeometry: {
      checkedCount: wallClaims.length,
      rejectedCount: rejectedWalls.length,
      rejected: rejectedWalls,
    },
    totalWarnings: warnings.length,
    warnings,
  };

  console.log(
    `[spatial-validation] done — storeys ${validContainerIds.size}/${levelClaims.length} valid,` +
    ` orphans ${orphanedElements.length},` +
    ` walls_rejected ${rejectedWalls.length}`
  );

  return { validatedDoc: doc, validationSummary };
}
