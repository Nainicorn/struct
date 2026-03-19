/**
 * DXF → Claims converter.
 * Converts the output of parseDxfToCSS() into a claims array.
 * Each CSS element becomes one claim with full attributes preserved for lossless CSS reconstruction.
 */

import {
  buildClaim, buildEvidence, typeToKind, inferDiscipline,
  CLAIM_KINDS, EXTRACTION_METHODS, COORDINATE_SOURCES, SOURCE_ROLES
} from './claimsSchema.mjs';

/**
 * Convert a DXF CSS object into claims + parserArtifacts.
 * @param {object} css - Full CSS object from parseDxfToCSS()
 * @param {string} sourceFileName - DXF source file name
 * @returns {{ claims: Array, domain: string, facilityMeta: object, parserArtifacts: object }}
 */
export function dxfCssToClaims(css, sourceFileName) {
  const claims = [];

  const evidence = buildEvidence(
    sourceFileName,
    SOURCE_ROLES.DRAWING,
    EXTRACTION_METHODS.DXF_PARSER,
    COORDINATE_SOURCES.DIRECT_2D
  );

  // DXF CSS uses storeys[].elements instead of top-level elements
  const storeys = css.storeys || [];
  for (const storey of storeys) {
    // Create a level_definition claim for each storey
    claims.push(buildClaim(
      CLAIM_KINDS.LEVEL_DEFINITION,
      storey.id,
      {
        id: storey.id,
        type: 'STOREY',
        name: storey.name,
        elevation_m: storey.elevation_m,
        height_m: storey.height_m,
      },
      {
        evidence: [evidence],
        confidence: 0.70,
        fieldConfidence: { dimensions: 0.70, placement: 0.70 },
        discipline: 'architectural',
      }
    ));

    // Convert each element in this storey to a claim
    for (const el of (storey.elements || [])) {
      const kind = typeToKind(el.type);
      const subjectId = el.element_key || el.id;

      const elEvidence = { ...evidence };
      if (el.dxfLayer) {
        elEvidence.dxfLayer = el.dxfLayer;
      }
      if (el.dxfHandle) {
        elEvidence.dxfHandle = el.dxfHandle;
      }

      // DXF elements have lower confidence than simulation data
      const fieldConfidence = {
        dimensions: 0.70,
        placement: 0.70,
        material: 0.40,
      };

      // Semantic upgrades (WALL, COLUMN etc.) have slightly higher confidence
      if (el.semanticType !== 'PROXY' && el.type !== 'EQUIPMENT') {
        fieldConfidence.dimensions = 0.80;
      }

      const attributes = {
        id: el.id,
        element_key: el.element_key,
        type: el.type,
        semanticType: el.semanticType,
        name: el.name,
        placement: el.placement,
        geometry: el.geometry,
        container: storey.id,
        relationships: el.relationships || [],
        properties: el.properties || {},
        material: el.material,
        source: el.source,
        sourceFile: el.sourceFile,
        metadata: el.metadata,
        dxfLayer: el.dxfLayer,
        dxfHandle: el.dxfHandle,
      };

      const aliases = [];
      if (el.dxfHandle) {
        aliases.push(`dxf_handle_${el.dxfHandle}`);
      }
      if (el.name && el.name !== el.element_key) {
        aliases.push(el.name);
      }

      claims.push(buildClaim(
        kind,
        subjectId,
        attributes,
        {
          evidence: [elEvidence],
          confidence: el.confidence ?? 0.50,
          fieldConfidence,
          discipline: inferDiscipline(el.type, el.properties),
          aliases,
        }
      ));
    }
  }

  // Extract facility metadata (DXF doesn't have explicit facility data)
  const facilityMeta = {
    name: css.metadata?.title || 'DXF Import',
    type: 'building',
    description: null,
    units: 'M',
    origin: { x: 0, y: 0, z: 0 },
    axes: 'RIGHT_HANDED_Z_UP',
  };

  // Parser artifacts for lossless CSS reconstruction
  const parserArtifacts = {
    parserType: 'DXF',
    metadata: css.metadata,
  };

  return {
    claims,
    domain: 'BUILDING',
    facilityMeta,
    parserArtifacts,
  };
}
