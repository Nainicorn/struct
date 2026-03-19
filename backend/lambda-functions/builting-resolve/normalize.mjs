/**
 * normalize.mjs — NormalizeClaims module.
 * Normalizes units, coordinate conventions, source roles, and claim shapes.
 * Produces normalized_claims.json (same shape as claims.json, with _original_* fields).
 */

import { CANONICAL_SOURCE_ROLES, VALID_STATUSES } from './schemas.mjs';

// Unit conversion factors to meters
const UNIT_TO_METERS = {
  M: 1.0,
  FT: 0.3048,
  IN: 0.0254,
  CM: 0.01,
  MM: 0.001,
  YD: 0.9144,
};

/**
 * Normalize a claims document in-place-safe (returns new object).
 * @param {object} claimsDoc - Raw claims envelope from Extract
 * @returns {object} Normalized claims envelope with _original_* preservation
 */
export function normalizeClaims(claimsDoc) {
  const doc = JSON.parse(JSON.stringify(claimsDoc)); // deep clone
  const warnings = [];

  // 1. Unit normalization
  const units = doc.facilityMeta?.units?.toUpperCase() || 'M';
  if (units !== 'M' && UNIT_TO_METERS[units]) {
    const factor = UNIT_TO_METERS[units];
    doc.facilityMeta._original_units = units;
    doc.facilityMeta.units = 'M';
    console.log(`NormalizeClaims: converting units from ${units} to M (factor=${factor})`);

    for (const claim of doc.claims) {
      normalizeClaimDimensions(claim, factor);
    }
  }

  // 2. Coordinate convention normalization
  const axes = doc.facilityMeta?.axes || 'RIGHT_HANDED_Z_UP';
  if (axes !== 'RIGHT_HANDED_Z_UP') {
    doc.facilityMeta._original_handedness = axes;
    doc.facilityMeta.axes = 'RIGHT_HANDED_Z_UP';
    warnings.push(`Coordinate convention ${axes} normalized to RIGHT_HANDED_Z_UP (coordinate transform not implemented — flagging only)`);
    console.log(`NormalizeClaims: flagging non-standard axes: ${axes}`);
  }

  // 3. Normalize each claim
  for (const claim of doc.claims) {
    normalizeClaimShape(claim, warnings);
    normalizeClaimEvidence(claim, warnings);
    normalizeClaimConfidence(claim);
  }

  if (warnings.length > 0) {
    doc._normalizationWarnings = warnings;
    console.log(`NormalizeClaims: ${warnings.length} warnings`);
  }

  console.log(`NormalizeClaims: processed ${doc.claims.length} claims`);
  return doc;
}

/**
 * Apply unit conversion factor to dimensional fields in claim attributes.
 */
function normalizeClaimDimensions(claim, factor) {
  const attrs = claim.attributes;
  if (!attrs) return;

  // Convert placement origin
  if (attrs.placement?.origin) {
    const o = attrs.placement.origin;
    if (typeof o.x === 'number') o.x *= factor;
    if (typeof o.y === 'number') o.y *= factor;
    if (typeof o.z === 'number') o.z *= factor;
  }

  // Convert geometry dimensions
  if (attrs.geometry) {
    const g = attrs.geometry;
    if (typeof g.depth === 'number') g.depth *= factor;
    if (typeof g.width === 'number') g.width *= factor;
    if (typeof g.height === 'number') g.height *= factor;

    // Profile dimensions
    if (g.profile) {
      if (typeof g.profile.width === 'number') g.profile.width *= factor;
      if (typeof g.profile.height === 'number') g.profile.height *= factor;
      if (typeof g.profile.radius === 'number') g.profile.radius *= factor;
    }

    // Dimensions sub-object
    if (g.dimensions) {
      for (const key of Object.keys(g.dimensions)) {
        if (typeof g.dimensions[key] === 'number') {
          g.dimensions[key] *= factor;
        }
      }
    }
  }
}

/**
 * Validate and fill defaults for required claim fields.
 */
function normalizeClaimShape(claim, warnings) {
  // Required fields
  if (!claim.claim_id) {
    warnings.push(`Claim missing claim_id (subject: ${claim.subject_local_id})`);
  }
  if (!claim.kind) {
    warnings.push(`Claim ${claim.claim_id} missing kind`);
  }
  if (!claim.subject_local_id) {
    warnings.push(`Claim ${claim.claim_id} missing subject_local_id`);
  }
  if (!claim.attributes) {
    claim.attributes = {};
    warnings.push(`Claim ${claim.claim_id} missing attributes — defaulted to empty`);
  }

  // Status normalization
  if (!claim.status || !VALID_STATUSES.has(claim.status)) {
    claim.status = 'asserted';
  }

  // Fill optional fields with defaults
  if (!Array.isArray(claim.alternatives)) claim.alternatives = [];
  if (typeof claim.requires_review !== 'boolean') claim.requires_review = false;
  if (!Array.isArray(claim.evidence)) claim.evidence = [];
  if (typeof claim.confidence !== 'number') claim.confidence = 0.5;
  if (!claim.fieldConfidence || typeof claim.fieldConfidence !== 'object') claim.fieldConfidence = {};
  if (!Array.isArray(claim.aliases)) claim.aliases = [];
  if (!claim.discipline) claim.discipline = 'unknown';
  if (!claim.parserVersion) claim.parserVersion = '1.0';
}

/**
 * Normalize evidence source roles to canonical values.
 */
function normalizeClaimEvidence(claim, warnings) {
  for (const ev of claim.evidence) {
    if (ev.sourceRole && !CANONICAL_SOURCE_ROLES.has(ev.sourceRole)) {
      // Try common mappings
      const mapped = mapSourceRole(ev.sourceRole);
      if (mapped !== ev.sourceRole) {
        if (!claim._original_labels) claim._original_labels = {};
        claim._original_labels[`sourceRole_${ev.source}`] = ev.sourceRole;
        ev.sourceRole = mapped;
      } else {
        warnings.push(`Claim ${claim.claim_id}: unrecognized sourceRole "${ev.sourceRole}" on evidence from ${ev.source}`);
      }
    }

    // Fill null evidence fields
    if (ev.excerpt === undefined) ev.excerpt = null;
    if (ev.page === undefined) ev.page = null;
    if (ev.region === undefined) ev.region = null;
    if (ev.sheetName === undefined) ev.sheetName = null;
    if (ev.dxfLayer === undefined) ev.dxfLayer = null;
    if (ev.dxfHandle === undefined) ev.dxfHandle = null;
  }
}

/**
 * Clamp confidence values to [0, 1].
 */
function normalizeClaimConfidence(claim) {
  claim.confidence = Math.max(0, Math.min(1, claim.confidence));

  if (claim.fieldConfidence) {
    for (const key of Object.keys(claim.fieldConfidence)) {
      if (typeof claim.fieldConfidence[key] === 'number') {
        claim.fieldConfidence[key] = Math.max(0, Math.min(1, claim.fieldConfidence[key]));
      }
    }
  }
}

/**
 * Map non-standard source roles to canonical values.
 */
function mapSourceRole(role) {
  if (!role) return 'NARRATIVE';
  const upper = role.toUpperCase();

  // Direct matches
  if (CANONICAL_SOURCE_ROLES.has(upper)) return upper;

  // Common aliases
  const aliases = {
    GEOMETRY: 'DRAWING',
    CAD: 'DRAWING',
    DXF: 'DRAWING',
    DWG: 'DRAWING',
    BLUEPRINT: 'DRAWING',
    TEXT: 'NARRATIVE',
    DOCUMENT: 'NARRATIVE',
    PDF: 'NARRATIVE',
    DESCRIPTION: 'NARRATIVE',
    SPEC: 'NARRATIVE',
    SPECIFICATION: 'NARRATIVE',
    SPREADSHEET: 'SCHEDULE',
    XLSX: 'SCHEDULE',
    CSV: 'SCHEDULE',
    TABLE: 'SCHEDULE',
    SIM: 'SIMULATION',
    VSM: 'SIMULATION',
    VENTSIM: 'SIMULATION',
    IMAGE: 'VISION',
    PHOTO: 'VISION',
    SCAN: 'VISION',
    SCREENSHOT: 'VISION',
  };

  return aliases[upper] || role;
}
