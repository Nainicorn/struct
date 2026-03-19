/**
 * identity.mjs — Identity assignment module.
 * Phase 2: All observations get new canonical IDs (no prior revision matching yet).
 * Designed for future extension to load prior identity_map.json and match.
 */

import { generateCanonicalId, generateInstanceId } from './schemas.mjs';

/**
 * Assign canonical and instance IDs to observations.
 * Phase 2: Every observation is a new assignment (no prior revision to match against).
 *
 * @param {Array} observations - Array of observation objects (without canonical_id/instance_id set)
 * @param {object} options - { previousIdentityMap, revision }
 * @returns {{ identityMap: object, observationsWithIds: Array }}
 */
export function assignIdentities(observations, options = {}) {
  const revision = options.revision || 1;
  const assignments = [];

  const observationsWithIds = observations.map(obs => {
    const canonicalId = generateCanonicalId();
    const instanceId = generateInstanceId();

    // Collect aliases from source claims (stored in obs during resolve step)
    const aliases = obs._sourceAliases || [];

    // Collect source handles from evidence
    const sourceHandles = {};
    if (obs.provenance?.sourceFiles) {
      for (const sf of obs.provenance.sourceFiles) {
        // Use the first source claim's subject_local_id as a handle
        if (obs._sourceSubjectIds?.[0]) {
          sourceHandles[sf] = obs._sourceSubjectIds[0];
        }
      }
    }

    // DXF handles from evidence
    if (obs._dxfHandle) {
      sourceHandles.dxf_handle = obs._dxfHandle;
    }
    if (obs._vsmUniqueNo) {
      sourceHandles.vsm_unique_no = obs._vsmUniqueNo;
    }

    // Build identity assignment
    assignments.push({
      canonical_id: canonicalId,
      instance_ids: [instanceId],
      aliases,
      source_handles: sourceHandles,
      first_seen_revision: revision,
      last_matched_revision: revision,
      matched_from_revision: null,
      match_confidence: 1.0,
      match_reason: 'new_assignment',
      locked: false,
      locked_fields: [],
    });

    // Set IDs on the observation (remove internal fields)
    const { _sourceAliases, _sourceSubjectIds, _dxfHandle, _vsmUniqueNo, ...cleanObs } = obs;
    return {
      ...cleanObs,
      canonical_id: canonicalId,
      instance_id: instanceId,
    };
  });

  const identityMap = { assignments };

  console.log(`Identity: assigned ${assignments.length} canonical IDs (all new, revision=${revision})`);

  return { identityMap, observationsWithIds };
}
