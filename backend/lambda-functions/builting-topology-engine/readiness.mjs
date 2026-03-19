/**
 * Readiness Evaluation
 *
 * Computes readiness score (0–100), evaluates 10 gates (hard/soft),
 * determines authoring suitability and generation mode recommendation,
 * and emits actionable recommendations.
 *
 * exportReadiness = all hard gates pass
 *   (means "passes hard validation gates," NOT "good model")
 * authoringSuitability = practical usefulness for downstream consumers
 */

import { GATES, SCORING, AUTHORING } from './config.mjs';

/**
 * Count issues matching specific check names across all category results.
 */
function countIssuesByCheck(allIssues, checkName) {
  return allIssues.filter(i => i.check === checkName).length;
}

function countIssuesByChecks(allIssues, checkNames) {
  return allIssues.filter(i => checkNames.includes(i.check)).length;
}

export function evaluateReadiness(semantic, geometric, topological, structural, config) {
  // Merge all issues
  const allIssues = [
    ...semantic.issues,
    ...geometric.issues,
    ...topological.issues,
    ...structural.issues
  ];

  const errorCount = allIssues.filter(i => i.severity === 'error').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const infoCount = allIssues.filter(i => i.severity === 'info').length;
  const blocksExportCount = allIssues.filter(i => i.blocks_export).length;

  // ── Evaluate Gates ──────────────────────────────────────────────────────

  const gates = {};
  const failedHardGates = [];
  const failedSoftGates = [];

  for (const [gateName, gateDef] of Object.entries(GATES)) {
    let issueCount;
    if (gateDef.checks) {
      issueCount = countIssuesByChecks(allIssues, gateDef.checks);
    } else {
      issueCount = countIssuesByCheck(allIssues, gateDef.check);
    }

    // Special case: meshGeometrySane only evaluates when mesh elements exist
    if (gateName === 'meshGeometrySane') {
      const hasMeshElements = allIssues.some(i =>
        i.check?.startsWith('mesh_'));
      if (!hasMeshElements) {
        gates[gateName] = true; // no mesh = passes by default
        continue;
      }
    }

    // Special case: extentWithinSafePrecision — only fail if out_of_bounds count is high
    if (gateName === 'extentWithinSafePrecision') {
      gates[gateName] = issueCount === 0;
    } else {
      gates[gateName] = issueCount === 0;
    }

    if (!gates[gateName]) {
      if (gateDef.hard) failedHardGates.push(gateName);
      else failedSoftGates.push(gateName);
    }
  }

  const exportReadiness = failedHardGates.length === 0;

  // ── Compute Score ─────────────────────────────────────────────────────

  const semSummary = semantic.summary;
  const geomSummary = geometric.summary;
  const topoSummary = topological.summary;
  const structSummary = structural.summary;

  const totalElements = (semSummary.confidenceDist.high + semSummary.confidenceDist.medium + semSummary.confidenceDist.low) || 1;

  // Positive factors (ratios × weights)
  const validGeomRatio = totalElements > 0
    ? (totalElements - geomSummary.nanCount - geomSummary.invalidPlacementCount) / totalElements
    : 0;
  const highConfRatio = semSummary.confidenceDist.high / totalElements;

  const totalContainers = topoSummary.containerValidity.valid + topoSummary.containerValidity.unresolved + topoSummary.containerValidity.invalid;
  const containerRatio = totalContainers > 0 ? topoSummary.containerValidity.valid / totalContainers : 1;

  const totalRels = topoSummary.relationshipIntegrity.valid + topoSummary.relationshipIntegrity.dangling + topoSummary.relationshipIntegrity.selfRef;
  const relRatio = totalRels > 0 ? topoSummary.relationshipIntegrity.valid / totalRels : 1;

  const domainViability = structSummary.domainRequirementsMet ? 1 : 0;

  let score = 0;
  score += Math.max(0, validGeomRatio) * SCORING.validGeometry;
  score += Math.max(0, highConfRatio) * SCORING.highConfidence;
  score += Math.max(0, containerRatio) * SCORING.containerValidity;
  score += Math.max(0, relRatio) * SCORING.relationshipIntegrity;
  score += domainViability * SCORING.domainViability;

  // Penalty factors (negative weights, clamped to not go below 0 contribution)
  const proxyRatio = semSummary.proxyRatio;
  score += Math.max(SCORING.proxyPenalty, -proxyRatio * Math.abs(SCORING.proxyPenalty));

  const criticalPenalty = Math.min(errorCount / 10, 1); // normalize: 10+ errors = full penalty
  score += Math.max(SCORING.criticalIssuePenalty, -criticalPenalty * Math.abs(SCORING.criticalIssuePenalty));

  const warningPenalty = Math.min(warningCount / 20, 1); // normalize: 20+ warnings = full penalty
  score += Math.max(SCORING.warningPenalty, -warningPenalty * Math.abs(SCORING.warningPenalty));

  const authoringRisk = failedSoftGates.length > 0 ? Math.min(failedSoftGates.length / 2, 1) : 0;
  score += Math.max(SCORING.authoringRiskPenalty, -authoringRisk * Math.abs(SCORING.authoringRiskPenalty));

  // Clamp 0–100
  score = Math.round(Math.max(0, Math.min(100, score)));

  // ── Authoring Suitability ─────────────────────────────────────────────

  let authoringSuitability;
  if (failedHardGates.length > 0 && errorCount > 5) {
    authoringSuitability = 'NOT_RECOMMENDED';
  } else if (failedHardGates.length > 0 || failedSoftGates.length > 0) {
    authoringSuitability = 'VIEWER_ONLY';
  } else if (score >= AUTHORING.FULL_AUTHORING_MIN_SCORE && proxyRatio < AUTHORING.FULL_AUTHORING_MAX_PROXY_RATIO) {
    authoringSuitability = 'FULL_AUTHORING';
  } else if (score >= AUTHORING.COORDINATION_MIN_SCORE) {
    authoringSuitability = 'COORDINATION_ONLY';
  } else {
    authoringSuitability = 'VIEWER_ONLY';
  }

  // ── Generation Mode Recommendation ────────────────────────────────────

  let generationModeRecommendation;
  if (score >= 80 && proxyRatio < AUTHORING.FULL_AUTHORING_MAX_PROXY_RATIO) {
    generationModeRecommendation = 'FULL_SEMANTIC';
  } else if (score < AUTHORING.PROXY_ONLY_MAX_SCORE || proxyRatio >= AUTHORING.PROXY_ONLY_MIN_RATIO) {
    generationModeRecommendation = 'PROXY_ONLY';
  } else {
    generationModeRecommendation = 'HYBRID';
  }

  // ── Recommendations ───────────────────────────────────────────────────

  const recommendations = [];

  if (proxyRatio > AUTHORING.PROXY_ONLY_MIN_RATIO) {
    recommendations.push('prefer_proxy_mode');
  }
  if (score >= AUTHORING.COORDINATION_MIN_SCORE && score < AUTHORING.FULL_AUTHORING_MIN_SCORE) {
    recommendations.push('safe_for_hybrid_generation');
  }
  if (topoSummary.openingHosting.orphaned > 0) {
    recommendations.push('requires_manual_review_for_openings');
  }
  if (authoringSuitability === 'VIEWER_ONLY') {
    recommendations.push('viewer_only_export_recommended');
  }
  if (structural.issues.some(i => i.check === 'shell_naming_inconsistent')) {
    recommendations.push('shell_naming_review_needed');
  }
  if (failedHardGates.length > 0) {
    recommendations.push(`hard_gates_failed: ${failedHardGates.join(', ')}`);
  }
  if (!structSummary.containerPresence) {
    recommendations.push('add_containers_for_spatial_structure');
  }
  if (geomSummary.localFrameIssueCount > 0) {
    recommendations.push('review_local_frame_definitions');
  }

  return {
    score,
    gates,
    failedHardGates,
    failedSoftGates,
    exportReadiness,
    authoringSuitability,
    generationModeRecommendation,
    criticalIssueCount: errorCount,
    warningCount,
    infoCount,
    blocksExportCount,
    recommendations
  };
}
