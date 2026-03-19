/**
 * Claims Merger — merges claims from multiple sources (e.g., primary parser + vision).
 * Phase 1: simple concatenation with deduplication by subject_local_id.
 * Phase 2+ will add multi-signal merge grouping.
 */

/**
 * Merge primary claims with additional claims (e.g., vision claims).
 * For Phase 1, this is a simple concatenation — no conflict resolution.
 * Duplicate subject_local_ids from secondary sources get a suffix to avoid collisions.
 *
 * @param {Array} primaryClaims - Claims from the primary parser
 * @param {Array} secondaryClaims - Claims from secondary sources (vision, etc.)
 * @returns {Array} Merged claims array
 */
export function mergeClaims(primaryClaims, secondaryClaims) {
  if (!secondaryClaims || secondaryClaims.length === 0) {
    return primaryClaims;
  }

  // Build a set of primary subject IDs for dedup check
  const primarySubjects = new Set(primaryClaims.map(c => c.subject_local_id));

  const merged = [...primaryClaims];

  for (const claim of secondaryClaims) {
    // If there's a collision on subject_local_id, suffix it
    if (primarySubjects.has(claim.subject_local_id)) {
      claim.subject_local_id = `${claim.subject_local_id}_secondary`;
    }
    merged.push(claim);
  }

  return merged;
}
