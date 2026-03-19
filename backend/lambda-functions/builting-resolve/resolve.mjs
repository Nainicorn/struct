/**
 * resolve.mjs — ResolveClaims module.
 * Groups claims by subject identity, resolves field conflicts, builds observations.
 */

import {
  KIND_TO_OBSERVATION_TYPE, KIND_TO_CANDIDATE_CLASS,
  EXTRACTION_METHOD_PRIORITY, COORDINATE_SOURCE_PRIORITY,
  OBSERVATION_STATUSES,
  extractionMethodToClassSource,
  generateObservationId, resetObservationCounter,
} from './schemas.mjs';

// Spatial proximity threshold for grouping (meters)
const SPATIAL_PROXIMITY_M = 0.5;
// Dimension tolerance for grouping (20%)
const DIMENSION_TOLERANCE = 0.2;
// Minimum confidence threshold — below this, claims are dropped
const MIN_CONFIDENCE = 0.2;

/**
 * Resolve normalized claims into observations + resolution report.
 * @param {object} normalizedDoc - Normalized claims envelope
 * @returns {{ observations: Array, resolutionReport: object }}
 */
export function resolveClaims(normalizedDoc) {
  resetObservationCounter();

  const claims = normalizedDoc.claims || [];
  const report = {
    schemaVersion: '1.0',
    claimGroups: [],
    mergedGroups: [],
    ambiguousGroups: [],
    droppedClaims: [],
    fieldResolutions: [],
    identityAssignments: [], // Filled later by identity.mjs
    summary: { claimsConsumed: claims.length, groupsCreated: 0, ambiguousGroups: 0, droppedClaims: 0 },
  };

  // Step 0: Filter out rejected and very low confidence claims
  const { activeClaims, dropped } = filterClaims(claims);
  report.droppedClaims = dropped;
  report.summary.droppedClaims = dropped.length;

  // Step A: Group claims by subject identity
  const groups = groupClaimsBySubject(activeClaims);
  report.claimGroups = groups.map(g => ({
    groupId: g.groupId,
    claimIds: g.claims.map(c => c.claim_id),
    subject: g.subject,
    strategy: g.claims.length > 1 ? 'merge' : 'passthrough',
    groupingSignalsUsed: g.signals,
  }));
  report.summary.groupsCreated = groups.length;

  // Step B + C: Resolve conflicts and build observations
  const observations = [];
  for (const group of groups) {
    const { observation, fieldResolutions, isAmbiguous } = resolveGroup(group);
    observations.push(observation);
    report.fieldResolutions.push(...fieldResolutions);
    if (isAmbiguous) {
      report.ambiguousGroups.push({
        groupId: group.groupId,
        reason: 'conflicting_claims_with_similar_confidence',
        claimIds: group.claims.map(c => c.claim_id),
      });
      report.summary.ambiguousGroups++;
    }
  }

  console.log(`ResolveClaims: ${claims.length} claims → ${observations.length} observations, ${dropped.length} dropped, ${report.summary.ambiguousGroups} ambiguous`);

  return { observations, resolutionReport: report };
}

/**
 * Filter out rejected and very low confidence claims.
 */
function filterClaims(claims) {
  const activeClaims = [];
  const dropped = [];

  for (const c of claims) {
    if (c.status === 'rejected') {
      dropped.push({ claimId: c.claim_id, reason: 'rejected_by_extractor', supersededBy: null });
    } else if (c.confidence < MIN_CONFIDENCE) {
      dropped.push({ claimId: c.claim_id, reason: 'below_confidence_threshold', supersededBy: null });
    } else {
      activeClaims.push(c);
    }
  }

  return { activeClaims, dropped };
}

/**
 * Group claims by subject identity using multiple signals.
 * Phase 2 signals: subject_local_id match, alias overlap, spatial proximity.
 */
function groupClaimsBySubject(claims) {
  let groupCounter = 0;
  const groups = [];
  const assigned = new Set(); // claim_ids already assigned to a group

  // Build indexes for efficient matching
  const bySubject = new Map(); // subject_local_id → [claims]
  const byAlias = new Map();   // alias → [claims]

  for (const c of claims) {
    const subj = c.subject_local_id;
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj).push(c);

    for (const alias of (c.aliases || [])) {
      if (!byAlias.has(alias)) byAlias.set(alias, []);
      byAlias.get(alias).push(c);
    }
  }

  // Signal 1: Group by exact subject_local_id
  for (const [subj, subjClaims] of bySubject) {
    const unassigned = subjClaims.filter(c => !assigned.has(c.claim_id));
    if (unassigned.length === 0) continue;

    groupCounter++;
    const groupId = `grp-${String(groupCounter).padStart(4, '0')}`;
    const signals = ['subject_local_id_match'];

    // Check if any additional claims should be merged via alias overlap
    const aliasMatches = new Set();
    for (const c of unassigned) {
      for (const alias of (c.aliases || [])) {
        const aliasGroup = byAlias.get(alias) || [];
        for (const ac of aliasGroup) {
          if (!assigned.has(ac.claim_id) && ac.claim_id !== c.claim_id && !unassigned.includes(ac)) {
            aliasMatches.add(ac);
          }
        }
      }
    }

    const allInGroup = [...unassigned];
    if (aliasMatches.size > 0) {
      allInGroup.push(...aliasMatches);
      signals.push('alias_match');
    }

    for (const c of allInGroup) {
      assigned.add(c.claim_id);
    }

    groups.push({
      groupId,
      subject: subj,
      claims: allInGroup,
      signals,
    });
  }

  // Signal 3: Spatial proximity for remaining unassigned claims
  const remaining = claims.filter(c => !assigned.has(c.claim_id));
  if (remaining.length > 0) {
    // Simple O(n²) proximity check — acceptable for typical claim counts (<500)
    const proximityGroups = groupBySpatialProximity(remaining);
    for (const pg of proximityGroups) {
      groupCounter++;
      const groupId = `grp-${String(groupCounter).padStart(4, '0')}`;
      for (const c of pg.claims) {
        assigned.add(c.claim_id);
      }
      groups.push({
        groupId,
        subject: pg.claims[0].subject_local_id,
        claims: pg.claims,
        signals: pg.signals,
      });
    }
  }

  return groups;
}

/**
 * Group remaining claims by spatial proximity + kind match.
 */
function groupBySpatialProximity(claims) {
  const groups = [];
  const used = new Set();

  for (let i = 0; i < claims.length; i++) {
    if (used.has(i)) continue;
    const cluster = [claims[i]];
    const signals = ['singleton'];
    used.add(i);

    for (let j = i + 1; j < claims.length; j++) {
      if (used.has(j)) continue;
      if (claims[i].kind !== claims[j].kind) continue;
      if (areSpatiallyClose(claims[i], claims[j])) {
        cluster.push(claims[j]);
        used.add(j);
        signals[0] = 'spatial_proximity';
      }
    }

    groups.push({ claims: cluster, signals });
  }

  return groups;
}

/**
 * Check if two claims are spatially close (same kind, origins within threshold).
 */
function areSpatiallyClose(a, b) {
  const aOrigin = a.attributes?.placement?.origin;
  const bOrigin = b.attributes?.placement?.origin;
  if (!aOrigin || !bOrigin) return false;

  const dx = (aOrigin.x || 0) - (bOrigin.x || 0);
  const dy = (aOrigin.y || 0) - (bOrigin.y || 0);
  const dz = (aOrigin.z || 0) - (bOrigin.z || 0);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (dist > SPATIAL_PROXIMITY_M) return false;

  // Also check dimension similarity if both have geometry
  const aGeom = a.attributes?.geometry;
  const bGeom = b.attributes?.geometry;
  if (aGeom?.depth && bGeom?.depth) {
    const ratio = Math.abs(aGeom.depth - bGeom.depth) / Math.max(aGeom.depth, bGeom.depth, 0.001);
    if (ratio > DIMENSION_TOLERANCE) return false;
  }

  return true;
}

/**
 * Resolve a group of claims into a single observation.
 */
function resolveGroup(group) {
  const fieldResolutions = [];
  let isAmbiguous = false;

  // For singleton groups, no conflict resolution needed
  if (group.claims.length === 1) {
    const claim = group.claims[0];
    const observation = buildObservation(claim, group);

    if (claim.status === 'ambiguous') {
      isAmbiguous = true;
    }

    return { observation, fieldResolutions, isAmbiguous };
  }

  // Multi-claim group: resolve field conflicts
  const winner = resolveFieldConflicts(group.claims, fieldResolutions, group.groupId);

  // Check for ambiguity: if top 2 claims have similar confidence, mark as ambiguous
  const sorted = [...group.claims].sort((a, b) => b.confidence - a.confidence);
  if (sorted.length >= 2 && Math.abs(sorted[0].confidence - sorted[1].confidence) < 0.1) {
    isAmbiguous = true;
  }

  const observation = buildObservation(winner, group);

  // Aggregate provenance from all claims in group
  const allSources = new Set();
  const allBasis = new Set();
  for (const c of group.claims) {
    for (const ev of c.evidence) {
      if (ev.source) allSources.add(ev.source);
      if (ev.extractionMethod) allBasis.add(ev.extractionMethod);
    }
  }
  observation.provenance.sourceFiles = [...allSources];
  observation.provenance.basis = [...allBasis];

  // Weighted average confidence
  const totalConf = group.claims.reduce((s, c) => s + c.confidence, 0);
  observation.confidence = totalConf / group.claims.length;

  // Collect all claim IDs
  observation.source_claim_ids = group.claims.map(c => c.claim_id);

  return { observation, fieldResolutions, isAmbiguous };
}

/**
 * Resolve field conflicts between multiple claims for the same entity.
 * Returns the "winning" claim with the best overall data.
 */
function resolveFieldConflicts(claims, fieldResolutions, groupId) {
  // Sort by confidence descending, then by extraction method priority
  const sorted = [...claims].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return getExtractionPriority(b) - getExtractionPriority(a);
  });

  const winner = sorted[0];

  // Check geometry field — prefer highest fieldConfidence.placement
  const geomWinner = findFieldWinner(claims, 'placement');
  if (geomWinner && geomWinner.claim_id !== winner.claim_id) {
    // Use geometry from the better geometric source
    if (winner.attributes && geomWinner.attributes?.placement) {
      winner.attributes.placement = geomWinner.attributes.placement;
      fieldResolutions.push({
        targetCanonicalId: null, // filled by identity.mjs
        field: 'placement',
        winnerClaimId: geomWinner.claim_id,
        loserClaimIds: claims.filter(c => c.claim_id !== geomWinner.claim_id).map(c => c.claim_id),
        policyUsed: 'highest_field_confidence_placement',
        reason: `fieldConfidence.placement: ${geomWinner.fieldConfidence?.placement || 'N/A'}`,
      });
    }
  }

  // Check material field — prefer highest confidence
  const matWinner = findFieldWinner(claims, 'material');
  if (matWinner && matWinner.claim_id !== winner.claim_id) {
    if (winner.attributes && matWinner.attributes?.material) {
      winner.attributes.material = matWinner.attributes.material;
      fieldResolutions.push({
        targetCanonicalId: null,
        field: 'material',
        winnerClaimId: matWinner.claim_id,
        loserClaimIds: claims.filter(c => c.claim_id !== matWinner.claim_id).map(c => c.claim_id),
        policyUsed: 'highest_confidence_material',
        reason: `confidence: ${matWinner.confidence}`,
      });
    }
  }

  return winner;
}

/**
 * Find the best claim for a specific field.
 */
function findFieldWinner(claims, field) {
  let best = null;
  let bestScore = -1;

  for (const c of claims) {
    const fc = c.fieldConfidence?.[field] || c.fieldConfidence?.dimensions || 0;
    const coordPriority = getCoordinateSourcePriority(c);
    const score = fc * 10 + coordPriority;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

/**
 * Get numeric priority for a claim's extraction method (higher = better).
 */
function getExtractionPriority(claim) {
  const method = claim.evidence?.[0]?.extractionMethod || 'HEURISTIC';
  const idx = EXTRACTION_METHOD_PRIORITY.indexOf(method);
  return idx >= 0 ? idx : 0;
}

/**
 * Get numeric priority for a claim's coordinate source (higher = better).
 */
function getCoordinateSourcePriority(claim) {
  const source = claim.evidence?.[0]?.coordinateSource || 'NONE';
  const idx = COORDINATE_SOURCE_PRIORITY.indexOf(source);
  return idx >= 0 ? idx : 0;
}

/**
 * Build an observation object from a (winning) claim.
 */
function buildObservation(claim, group) {
  const attrs = claim.attributes || {};
  const kind = claim.kind;
  const primaryEvidence = claim.evidence?.[0] || {};

  // Extract geometry evidence from attributes
  const geometryEvidence = {
    curves: [],
    points: [],
    profiles: [],
    rawCoordinates: [],
    dimensions: {},
  };

  if (attrs.placement?.origin) {
    geometryEvidence.points.push(attrs.placement.origin);
  }
  if (attrs.geometry?.profile) {
    geometryEvidence.profiles.push(attrs.geometry.profile);
  }
  if (attrs.geometry) {
    const g = attrs.geometry;
    if (g.depth) geometryEvidence.dimensions.depth = g.depth;
    if (g.width) geometryEvidence.dimensions.width = g.width;
    if (g.height) geometryEvidence.dimensions.height = g.height;
    if (g.dimensions) Object.assign(geometryEvidence.dimensions, g.dimensions);
  }

  // Extract semantic evidence from attributes
  const semanticEvidence = {
    labels: [],
    tags: [],
    properties: attrs.properties || {},
    materials: [],
  };

  if (attrs.name) semanticEvidence.labels.push(attrs.name);
  if (attrs.type) semanticEvidence.tags.push(attrs.type);
  if (attrs.semanticType) semanticEvidence.tags.push(attrs.semanticType);
  if (attrs.material) semanticEvidence.materials.push(attrs.material);

  // Extract context evidence
  const contextEvidence = {
    containerHints: [],
    adjacencyHints: [],
    hostHints: [],
    systemHints: [],
  };

  if (attrs.container) contextEvidence.containerHints.push(attrs.container);
  if (attrs.relationships) {
    for (const rel of attrs.relationships) {
      if (rel.type === 'HOSTED_BY' || rel.type === 'FILLS') contextEvidence.hostHints.push(rel.target);
      else if (rel.type === 'ADJACENT_TO') contextEvidence.adjacencyHints.push(rel.target);
      else if (rel.type === 'MEMBER_OF') contextEvidence.systemHints.push(rel.target);
    }
  }

  // Determine observation status
  let observationStatus = OBSERVATION_STATUSES.ACCEPTED;
  if (claim.status === 'ambiguous') observationStatus = OBSERVATION_STATUSES.AMBIGUOUS;

  // Derive candidate class source
  const classSource = extractionMethodToClassSource(primaryEvidence.extractionMethod);

  // Collect internal metadata for identity.mjs
  const sourceAliases = [];
  const sourceSubjectIds = [];
  for (const c of group.claims) {
    sourceAliases.push(...(c.aliases || []));
    sourceSubjectIds.push(c.subject_local_id);
  }

  // Collect source handles
  let dxfHandle = null;
  let vsmUniqueNo = null;
  for (const c of group.claims) {
    for (const ev of c.evidence) {
      if (ev.dxfHandle && !dxfHandle) dxfHandle = ev.dxfHandle;
    }
    if (c.attributes?.properties?.unique_no !== undefined && !vsmUniqueNo) {
      vsmUniqueNo = String(c.attributes.properties.unique_no);
    }
  }

  return {
    observation_id: generateObservationId(),
    canonical_id: null, // Set by identity.mjs
    instance_id: null,  // Set by identity.mjs
    source_claim_ids: group.claims.map(c => c.claim_id),
    observation_type: KIND_TO_OBSERVATION_TYPE[kind] || 'text_fact',
    observation_status: observationStatus,
    candidate_class: KIND_TO_CANDIDATE_CLASS[kind] || 'unknown',
    candidate_class_source: classSource,
    geometry_evidence: geometryEvidence,
    semantic_evidence: semanticEvidence,
    context_evidence: contextEvidence,
    confidence: claim.confidence,
    provenance: {
      basis: claim.evidence.map(e => e.extractionMethod).filter(Boolean),
      coordinateSource: primaryEvidence.coordinateSource || 'NONE',
      sourceFiles: claim.evidence.map(e => e.source).filter(Boolean),
    },
    // Internal fields (removed by identity.mjs)
    _sourceAliases: [...new Set(sourceAliases)],
    _sourceSubjectIds: [...new Set(sourceSubjectIds)],
    _dxfHandle: dxfHandle,
    _vsmUniqueNo: vsmUniqueNo,
  };
}
