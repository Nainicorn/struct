import { vecDist, vecNormalize, vecDot, vecSub, vecAdd, vecLen, vecCross, canonicalWallDirection } from './shared.mjs';

// ============================================================================
// PHASE 3-TOPO-B: BUILD PATH CONNECTIONS
// Converts topology graph into PATH_CONNECTS relationships on elements.
// ============================================================================

// Compatibility table: which element type pairs allow PATH_CONNECTS
const PATH_CONNECT_COMPATIBLE = {
  WALL: new Set(['WALL']),
  SLAB: new Set(['SLAB']),
};

/**
 * Compute connection angle between two wall elements at a shared node.
 * Returns { angleDeg, connectionType } where connectionType is:
 *   'MITRE'   — angle 10°–170° (walls meet at an angle, bisector cut)
 *   'BUTT'    — angle ~180° (collinear continuation, square end)
 *   'TEE'     — angle ~90° (perpendicular junction)
 * Falls back to null if direction cannot be determined.
 */
function computeWallConnectionAngle(elemA, elemB) {
  const dirA = canonicalWallDirection(elemA);
  const dirB = canonicalWallDirection(elemB);
  if (!dirA || !dirB) return null;

  const nA = vecNormalize(dirA);
  const nB = vecNormalize(dirB);
  if (!nA || !nB) return null;

  // Use absolute dot product (wall direction is bidirectional)
  const dot = Math.abs(vecDot(nA, nB));
  const clampedDot = Math.min(1.0, Math.max(-1.0, dot));
  const angleDeg = Math.acos(clampedDot) * (180 / Math.PI);

  let connectionType = 'MITRE';
  if (angleDeg < 10)       connectionType = 'BUTT';    // nearly collinear
  else if (angleDeg > 80 && angleDeg < 100) connectionType = 'TEE';
  else if (angleDeg > 170)  connectionType = 'BUTT';

  return { angleDeg: Math.round(angleDeg * 10) / 10, connectionType };
}

function buildPathConnections(css) {
  if (!css.topology?.nodes || !css.topology?.runs) return;

  const runsById = new Map(css.topology.runs.map(r => [r.id, r]));
  const runsByBranch = new Map(css.topology.runs.map(r => [r.branchKey, r]));
  const elemByKey = new Map(css.elements.map(e => [e.element_key || e.id, e]));
  const exportProfile = css.metadata?.exportProfile || 'authoring_safe';

  const SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'];
  let pathConnectCount = 0;

  // --- TUNNEL/LINEAR: Connect shell pieces at degree-2 nodes ---
  for (const node of css.topology.nodes) {
    if (node.degree !== 2) continue;

    const uniqueBranches = [...new Set(node.connectedBranches)];
    if (uniqueBranches.length !== 2) continue;

    const [runA, runB] = uniqueBranches.map(b => runsByBranch.get(b)).filter(Boolean);
    if (!runA || !runB) continue;

    // For linear topology (tunnel shells)
    if (runA.shellPieces && runB.shellPieces) {
      for (const role of SHELL_ROLES) {
        const aKey = runA.shellPieces[role];
        const bKey = runB.shellPieces[role];
        if (!aKey || !bKey) continue;

        const a = elemByKey.get(aKey);
        const b = elemByKey.get(bKey);
        if (!a || !b) continue;

        // Compatibility check
        const aType = a.type || 'UNKNOWN';
        const bType = b.type || 'UNKNOWN';
        const compatible = PATH_CONNECT_COMPATIBLE[aType];
        if (compatible && !compatible.has(bType)) continue;

        // Proxy check for authoring_safe
        if (exportProfile === 'authoring_safe') {
          if ((aType === 'PROXY' && !a.properties?.isProxyFallback) ||
              (bType === 'PROXY' && !b.properties?.isProxyFallback)) continue;
        }

        const aEnd = inferRunEnd(runA, node.id);
        const bEnd = inferRunEnd(runB, node.id);

        // Compute bend angle between shell pieces so generate can apply mitre clips.
        // Same lateral-direction comparison as architectural walls — angle magnitude is identical
        // whether we compare run dirs or lateral dirs (they're perpendicular to each other).
        let shellConnectionAngle = null;
        if (aType === 'WALL' && bType === 'WALL') {
          shellConnectionAngle = computeWallConnectionAngle(a, b);
        }

        if (!a.relationships) a.relationships = [];
        if (!b.relationships) b.relationships = [];

        a.relationships.push({
          type: 'PATH_CONNECTS',
          target: b.element_key || b.id,
          sourceInterface: { kind: aEnd, node: node.id },
          targetInterface: { kind: bEnd, node: node.id },
          role: 'STRUCTURAL_CONTINUITY',
          metadata: { shellRole: role, sourceElementType: aType, targetElementType: bType, connectionAngle: shellConnectionAngle }
        });

        b.relationships.push({
          type: 'PATH_CONNECTS',
          target: a.element_key || a.id,
          sourceInterface: { kind: bEnd, node: node.id },
          targetInterface: { kind: aEnd, node: node.id },
          role: 'STRUCTURAL_CONTINUITY',
          metadata: { shellRole: role, sourceElementType: bType, targetElementType: aType, connectionAngle: shellConnectionAngle }
        });

        pathConnectCount++;
      }
    }

    // For tunnel topology: also connect the PARENT TUNNEL_SEGMENT elements (hollow manifold).
    // Shell piece PATH_CONNECTS above are skipped in generate because shell pieces are replaced
    // by a single hollow solid — so we must add connections on the parent elements too.
    // Tunnel runs use branchKey (not elementKey) as their structural parent identifier.
    if (runA.shellPieces && runB.shellPieces && runA.branchKey && runB.branchKey) {
      const a = elemByKey.get(runA.branchKey);
      const b = elemByKey.get(runB.branchKey);
      if (a && b) {
        const aType = a.type || 'UNKNOWN';
        const bType = b.type || 'UNKNOWN';
        const aEnd = inferRunEnd(runA, node.id);
        const bEnd = inferRunEnd(runB, node.id);
        // Connection angle between parent segments (may be null for non-wall types)
        const parentAngle = (aType === 'WALL' || aType === 'TUNNEL_SEGMENT')
          ? computeWallConnectionAngle(a, b)
          : null;

        if (!a.relationships) a.relationships = [];
        if (!b.relationships) b.relationships = [];

        a.relationships.push({
          type: 'PATH_CONNECTS',
          target: b.element_key || b.id,
          sourceInterface: { kind: aEnd, node: node.id },
          targetInterface: { kind: bEnd, node: node.id },
          role: 'STRUCTURAL_CONTINUITY',
          metadata: { shellRole: null, sourceElementType: aType, targetElementType: bType, connectionAngle: parentAngle }
        });
        b.relationships.push({
          type: 'PATH_CONNECTS',
          target: a.element_key || a.id,
          sourceInterface: { kind: bEnd, node: node.id },
          targetInterface: { kind: aEnd, node: node.id },
          role: 'STRUCTURAL_CONTINUITY',
          metadata: { shellRole: null, sourceElementType: bType, targetElementType: aType, connectionAngle: parentAngle }
        });
        pathConnectCount++;
      }
    }

    // For architectural topology (wall endpoints)
    if (runA.elementKey && runB.elementKey && !runA.shellPieces?.LEFT_WALL) {
      const a = elemByKey.get(runA.elementKey);
      const b = elemByKey.get(runB.elementKey);
      if (!a || !b) continue;

      const aType = a.type || 'UNKNOWN';
      const bType = b.type || 'UNKNOWN';
      const compatible = PATH_CONNECT_COMPATIBLE[aType];
      if (compatible && !compatible.has(bType)) continue;

      const aEnd = inferRunEnd(runA, node.id);
      const bEnd = inferRunEnd(runB, node.id);

      // Compute connection angle for wall-to-wall junctions (mitre/bevel/butt)
      let connectionAngle = null;
      if (aType === 'WALL' && bType === 'WALL') {
        connectionAngle = computeWallConnectionAngle(a, b);
      }

      if (!a.relationships) a.relationships = [];
      if (!b.relationships) b.relationships = [];

      a.relationships.push({
        type: 'PATH_CONNECTS',
        target: b.element_key || b.id,
        sourceInterface: { kind: aEnd, node: node.id },
        targetInterface: { kind: bEnd, node: node.id },
        role: 'STRUCTURAL_CONTINUITY',
        metadata: { shellRole: null, sourceElementType: aType, targetElementType: bType, connectionAngle }
      });

      b.relationships.push({
        type: 'PATH_CONNECTS',
        target: a.element_key || a.id,
        sourceInterface: { kind: bEnd, node: node.id },
        targetInterface: { kind: aEnd, node: node.id },
        role: 'STRUCTURAL_CONTINUITY',
        metadata: { shellRole: null, sourceElementType: bType, targetElementType: aType, connectionAngle }
      });

      pathConnectCount++;
    }
  }

  // --- JUNCTION NODES: Connect shell pieces to transition elements ---
  for (const junction of (css.topology.junctions || [])) {
    if (!junction.transitionElementIds || junction.transitionElementIds.length === 0) continue;

    const junctionNode = css.topology.nodes.find(n => n.id === junction.node);
    if (!junctionNode) continue;

    for (const transitionKey of junction.transitionElementIds) {
      const transition = elemByKey.get(transitionKey);
      if (!transition || transition.properties?.shellPiece === 'VOID') continue;

      // Connect each run's shell pieces to the transition element
      for (const runId of junction.connectedRuns) {
        const run = runsById.get(runId);
        if (!run) continue;

        for (const role of SHELL_ROLES) {
          const shellKey = run.shellPieces?.[role];
          if (!shellKey) continue;
          const shell = elemByKey.get(shellKey);
          if (!shell) continue;

          const shellEnd = inferRunEnd(run, junctionNode.id);

          if (!shell.relationships) shell.relationships = [];
          if (!transition.relationships) transition.relationships = [];

          shell.relationships.push({
            type: 'PATH_CONNECTS',
            target: transitionKey,
            sourceInterface: { kind: shellEnd, node: junctionNode.id },
            targetInterface: { kind: 'ATPATH', node: junctionNode.id },
            role: 'JUNCTION_CONTINUITY',
            metadata: { shellRole: role, sourceElementType: shell.type, targetElementType: transition.type }
          });

          transition.relationships.push({
            type: 'PATH_CONNECTS',
            target: shellKey,
            sourceInterface: { kind: 'ATPATH', node: junctionNode.id },
            targetInterface: { kind: shellEnd, node: junctionNode.id },
            role: 'JUNCTION_CONTINUITY',
            metadata: { shellRole: role, sourceElementType: transition.type, targetElementType: shell.type }
          });

          pathConnectCount++;
        }
      }
    }
  }

  // --- ARCHITECTURAL JUNCTIONS: Direct connections (T, L, cross) ---
  for (const junction of (css.topology.junctions || [])) {
    if (junction.transitionElementIds && junction.transitionElementIds.length > 0) continue;
    if (junction.kind === 'MULTI_BRANCH' && !['T_INTERSECTION', 'CROSS_INTERSECTION'].includes(junction.kind)) continue;

    const junctionNode = css.topology.nodes.find(n => n.id === junction.node);
    if (!junctionNode) continue;

    const connectedRuns = junction.connectedRuns.map(id => runsById.get(id)).filter(Boolean);
    if (connectedRuns.length < 2) continue;

    // Connect each pair at the junction
    for (let i = 0; i < connectedRuns.length; i++) {
      for (let j = i + 1; j < connectedRuns.length; j++) {
        const runI = connectedRuns[i];
        const runJ = connectedRuns[j];

        const elemI = elemByKey.get(runI.elementKey || runI.branchKey);
        const elemJ = elemByKey.get(runJ.elementKey || runJ.branchKey);
        if (!elemI || !elemJ) continue;

        const iType = elemI.type || 'UNKNOWN';
        const jType = elemJ.type || 'UNKNOWN';
        const compatible = PATH_CONNECT_COMPATIBLE[iType];
        if (compatible && !compatible.has(jType)) continue;

        const iEnd = inferRunEnd(runI, junctionNode.id);
        const jEnd = inferRunEnd(runJ, junctionNode.id);

        if (!elemI.relationships) elemI.relationships = [];
        if (!elemJ.relationships) elemJ.relationships = [];

        elemI.relationships.push({
          type: 'PATH_CONNECTS',
          target: elemJ.element_key || elemJ.id,
          sourceInterface: { kind: iEnd, node: junctionNode.id },
          targetInterface: { kind: jEnd, node: junctionNode.id },
          role: 'STRUCTURAL_CONTINUITY',
          metadata: { shellRole: null, sourceElementType: iType, targetElementType: jType }
        });

        elemJ.relationships.push({
          type: 'PATH_CONNECTS',
          target: elemI.element_key || elemI.id,
          sourceInterface: { kind: jEnd, node: junctionNode.id },
          targetInterface: { kind: iEnd, node: junctionNode.id },
          role: 'STRUCTURAL_CONTINUITY',
          metadata: { shellRole: null, sourceElementType: jType, targetElementType: iType }
        });

        pathConnectCount++;
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.pathConnections = { count: pathConnectCount };
  if (pathConnectCount > 0) {
    console.log(`buildPathConnections: ${pathConnectCount} path connections created`);
  }
}

/**
 * Determine whether a run's start or end is at the given node.
 */
function inferRunEnd(run, nodeId) {
  if (run.startNode === nodeId) return 'ATSTART';
  if (run.endNode === nodeId) return 'ATEND';
  return 'NOTDEFINED';
}

export { buildPathConnections };
