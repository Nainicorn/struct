/**
 * Claims → Legacy CSS converter.
 * Reconstructs the exact CSS object from claims + parserArtifacts.
 * Since claims store complete element data in `attributes`, this is a flattening operation.
 */

import { CLAIM_KINDS } from './claimsSchema.mjs';

/**
 * Convert a claims document back to legacy CSS format.
 * @param {object} claimsDoc - Full claims envelope (claimsVersion, domain, facilityMeta, claims, ...)
 * @param {object} parserArtifacts - Parser-specific metadata needed for exact CSS reconstruction
 * @returns {object} CSS object identical to the original parser output
 */
export function claimsToLegacyCss(claimsDoc, parserArtifacts = {}) {
  const { parserType } = parserArtifacts;

  switch (parserType) {
    case 'VENTSIM':
      return claimsToVentSimCss(claimsDoc, parserArtifacts);
    case 'DXF':
      return claimsToDxfCss(claimsDoc, parserArtifacts);
    case 'BEDROCK_BUILDING':
    case 'BEDROCK_TUNNEL':
      return claimsToBedrockCss(claimsDoc, parserArtifacts);
    default:
      // Fallback: generic reconstruction
      return claimsToGenericCss(claimsDoc, parserArtifacts);
  }
}

/**
 * Reconstruct VentSim CSS from claims.
 */
function claimsToVentSimCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'TUNNEL',
    facility: artifacts.facility || facilityFromMeta(claimsDoc.facilityMeta),
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata: artifacts.metadata || {},
  };
}

/**
 * Reconstruct DXF CSS from claims — flat CSS v1.0 contract.
 */
function claimsToDxfCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'BUILDING',
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata: artifacts.metadata || {
      title: 'DXF Import',
      source: 'DXF',
      confidence: 0.5,
      schema_version: '1.0',
    },
  };
}

/**
 * Reconstruct Bedrock-extracted CSS from claims.
 */
function claimsToBedrockCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'BUILDING',
    facility: artifacts.facility || facilityFromMeta(claimsDoc.facilityMeta),
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata: artifacts.metadata || {},
  };
}

/**
 * Generic CSS reconstruction for unknown parser types.
 */
function claimsToGenericCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'UNKNOWN',
    facility: artifacts.facility || facilityFromMeta(claimsDoc.facilityMeta),
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata: artifacts.metadata || {},
  };
}

/**
 * Extract CSS elements from claims by flattening claim.attributes back into element objects.
 * Only processes element-type claims (not level_definition, facility_dimension, etc.).
 */
function extractElementsFromClaims(claims) {
  const elementKinds = new Set([
    CLAIM_KINDS.SEGMENT_GEOMETRY,
    CLAIM_KINDS.WALL_CANDIDATE,
    CLAIM_KINDS.SLAB_CANDIDATE,
    CLAIM_KINDS.EQUIPMENT_INSTANCE,
    CLAIM_KINDS.OPENING_CANDIDATE,
    CLAIM_KINDS.SPACE_DEFINITION,
    CLAIM_KINDS.COLUMN_CANDIDATE,
    CLAIM_KINDS.PORTAL_DEFINITION,
    CLAIM_KINDS.JUNCTION_DEFINITION,
    CLAIM_KINDS.VISION_FINDING,
  ]);

  return claims
    .filter(c => elementKinds.has(c.kind))
    .map(c => {
      // Flatten attributes back into a CSS element
      const el = { ...c.attributes };
      // Ensure confidence is preserved (claim confidence overrides if attributes didn't have it)
      if (el.confidence === undefined) {
        el.confidence = c.confidence;
      }
      return el;
    });
}

/**
 * Extract level/segment definitions from claims.
 */
function extractLevelsFromClaims(claims) {
  return claims
    .filter(c => c.kind === CLAIM_KINDS.LEVEL_DEFINITION)
    .map(c => ({ ...c.attributes }));
}

/**
 * Build facility object from facilityMeta.
 */
function facilityFromMeta(meta) {
  if (!meta) return { name: null, type: null, description: null, units: 'M', origin: { x: 0, y: 0, z: 0 }, axes: 'RIGHT_HANDED_Z_UP' };
  return {
    name: meta.name,
    type: meta.type,
    description: meta.description,
    units: meta.units || 'M',
    crs: null,
    origin: meta.origin || { x: 0, y: 0, z: 0 },
    axes: meta.axes || 'RIGHT_HANDED_Z_UP',
  };
}
