import { vecDist } from './shared.mjs';

// ============================================================================
// PHASE 3-TOPO-C: VALIDATE TOPOLOGY
// Validates topology graph integrity, PATH_CONNECTS coverage, proxy ratios.
// ============================================================================

function validateTopology(css) {
  if (!css.topology) {
    if (!css.metadata) css.metadata = {};
    css.metadata.topologyValidation = {
      valid: true, errors: [], warnings: ['No topology built — skipped validation'],
      metrics: { runs: 0, degree2Nodes: 0, connectedDegree2Nodes: 0, junctions: 0, transitions: 0, openings: 0, hostedEquipment: 0, connectivityCoverage: 0, proxyRatio: 0 }
    };
    return;
  }

  const errors = [];
  const warnings = [];
  const exportProfile = css.metadata?.exportProfile || 'authoring_safe';
  const domain = (css.metadata?.structureClass || 'BUILDING').toUpperCase();
  const isLinear = ['TUNNEL', 'LINEAR'].includes(domain);

  const elemByKey = new Map(css.elements.map(e => [e.element_key || e.id, e]));
  const runsById = new Map(css.topology.runs.map(r => [r.id, r]));

  // --- Check 1: Every run has startNode and endNode ---
  for (const run of css.topology.runs) {
    if (!run.startNode) errors.push(`Run ${run.id} missing startNode`);
    if (!run.endNode) errors.push(`Run ${run.id} missing endNode`);
  }

  // --- Check 2: Degree-2 nodes have PATH_CONNECTS for matching shell roles ---
  let degree2Nodes = 0;
  let connectedDegree2Nodes = 0;

  for (const node of css.topology.nodes) {
    if (node.degree !== 2) continue;
    degree2Nodes++;

    const uniqueBranches = [...new Set(node.connectedBranches)];
    if (uniqueBranches.length !== 2) continue;

    // Check that at least one PATH_CONNECTS exists crossing this node
    let hasConnection = false;

    if (isLinear) {
      const SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'];
      const runs = uniqueBranches.map(b => css.topology.runs.find(r => r.branchKey === b)).filter(Boolean);
      if (runs.length === 2) {
        for (const role of SHELL_ROLES) {
          const aKey = runs[0].shellPieces?.[role];
          const bKey = runs[1].shellPieces?.[role];
          if (!aKey || !bKey) continue;

          const a = elemByKey.get(aKey);
          if (a?.relationships?.some(r => r.type === 'PATH_CONNECTS' && r.target === bKey)) {
            hasConnection = true;
            break;
          }
        }
      }
    } else {
      // Architectural: check runs have connected elements
      const runKeys = uniqueBranches.map(b => {
        const run = css.topology.runs.find(r => r.branchKey === b);
        return run?.elementKey || run?.branchKey;
      }).filter(Boolean);

      if (runKeys.length === 2) {
        const elem = elemByKey.get(runKeys[0]);
        if (elem?.relationships?.some(r => r.type === 'PATH_CONNECTS' && r.target === runKeys[1])) {
          hasConnection = true;
        }
      }
    }

    if (hasConnection) {
      connectedDegree2Nodes++;
    } else {
      const msg = `Node ${node.id} (degree-2) has no PATH_CONNECTS between branches [${uniqueBranches.join(', ')}]`;
      if (exportProfile === 'authoring_safe') errors.push(msg);
      else warnings.push(msg);
    }
  }

  // --- Check 3: Degree-3+ nodes have transitions (linear) or direct connections (architectural) ---
  let transitionCount = 0;
  for (const junction of css.topology.junctions) {
    if (isLinear) {
      if (junction.transitionElementIds.length > 0) {
        transitionCount += junction.transitionElementIds.length;
      } else {
        const msg = `Junction ${junction.id} at ${junction.node} has no transition elements`;
        if (exportProfile === 'authoring_safe') errors.push(msg);
        else warnings.push(msg);
      }
    } else {
      // Architectural: check that connected runs have PATH_CONNECTS at this node
      let hasAnyConnection = false;
      for (const runId of junction.connectedRuns) {
        const run = runsById.get(runId);
        const elemKey = run?.elementKey || run?.branchKey;
        const elem = elemKey ? elemByKey.get(elemKey) : null;
        if (elem?.relationships?.some(r => r.type === 'PATH_CONNECTS')) {
          hasAnyConnection = true;
          break;
        }
      }
      if (!hasAnyConnection) {
        warnings.push(`Architectural junction ${junction.id} has no direct PATH_CONNECTS`);
      }
    }
  }

  // --- Check 4: Opening hosts ---
  const openings = css.elements.filter(e =>
    e.type === 'DOOR' || e.type === 'WINDOW' ||
    e.semanticType === 'IfcDoor' || e.semanticType === 'IfcWindow'
  );
  let openingsWithHost = 0;
  for (const opening of openings) {
    const hasVoids = opening.relationships?.some(r => r.type === 'VOIDS');
    if (hasVoids) {
      openingsWithHost++;
    } else {
      const msg = `Opening ${opening.element_key || opening.id} has no VOIDS host`;
      if (exportProfile === 'analysis') warnings.push(msg);
      else errors.push(msg);
    }
  }

  // --- Check 5: Merged runs preserve topology endpoints ---
  const mergedRuns = css.elements.filter(e => e.properties?.isMergedRun);
  for (const mr of mergedRuns) {
    const key = mr.element_key || mr.id;
    const participatesInTopology = css.topology.runs.some(r =>
      r.shellPieces && Object.values(r.shellPieces).includes(key)
    );
    if (participatesInTopology) {
      const hasPathConnect = mr.relationships?.some(r => r.type === 'PATH_CONNECTS');
      if (!hasPathConnect) {
        warnings.push(`Merged run ${key} participates in topology but has no PATH_CONNECTS`);
      }
    }
  }

  // --- Check 6: Proxy ratio ---
  const structuralTypes = new Set(['WALL', 'SLAB', 'PROXY']);
  const structuralElems = css.elements.filter(e => structuralTypes.has(e.type));
  const proxyElems = structuralElems.filter(e => e.type === 'PROXY');
  const proxyRatio = structuralElems.length > 0 ? proxyElems.length / structuralElems.length : 0;

  // Check proxy fallback flags
  for (const proxy of proxyElems) {
    if (!proxy.properties?.isProxyFallback && !proxy.properties?.isTransitionHelper) {
      const msg = `Structural proxy ${proxy.element_key || proxy.id} missing isProxyFallback flag and proxyFallbackReason`;
      if (exportProfile === 'authoring_safe') errors.push(msg);
      else warnings.push(msg);
    }
  }

  if (proxyRatio > 0.05) {
    const msg = `Structural proxy ratio ${(proxyRatio * 100).toFixed(1)}% exceeds 5% threshold`;
    if (exportProfile === 'authoring_safe') errors.push(msg);
    else warnings.push(msg);
  }

  // --- Check 7: Equipment hosting ---
  const equipment = css.elements.filter(e => e.type === 'EQUIPMENT' || e.semanticType?.startsWith('IfcFlowTerminal') || e.semanticType?.startsWith('IfcDistribution'));
  let hostedEquipment = 0;
  for (const eq of equipment) {
    const hasHosting = eq.relationships?.some(r => r.type === 'HOSTED_BY');
    const hasSpaceKey = eq.metadata?.hostSpaceKey;
    if (hasHosting) {
      hostedEquipment++;
    } else if (hasSpaceKey) {
      hostedEquipment++; // spatially contained, acceptable
      warnings.push(`Equipment ${eq.element_key || eq.id} has hostSpaceKey but no HOSTED_BY`);
    }
  }

  // --- Compute connectivity coverage ---
  const connectivityCoverage = degree2Nodes > 0 ? connectedDegree2Nodes / degree2Nodes : 1.0;

  // Profile-dependent coverage gate
  if (connectivityCoverage < 0.95 && exportProfile === 'authoring_safe') {
    errors.push(`connectivityCoverage ${(connectivityCoverage * 100).toFixed(1)}% below 95% threshold for authoring_safe`);
  } else if (connectivityCoverage < 0.80 && exportProfile === 'coordination') {
    errors.push(`connectivityCoverage ${(connectivityCoverage * 100).toFixed(1)}% below 80% threshold for coordination`);
  } else if (connectivityCoverage < 0.95) {
    warnings.push(`connectivityCoverage ${(connectivityCoverage * 100).toFixed(1)}%`);
  }

  const valid = errors.length === 0;

  if (!css.metadata) css.metadata = {};
  css.metadata.topologyValidation = {
    valid,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 20),
    metrics: {
      runs: css.topology.runs.length,
      degree2Nodes,
      connectedDegree2Nodes,
      junctions: css.topology.junctions.length,
      transitions: transitionCount,
      openings: openings.length,
      hostedEquipment,
      connectivityCoverage: Math.round(connectivityCoverage * 1000) / 1000,
      proxyRatio: Math.round(proxyRatio * 1000) / 1000
    }
  };

  console.log(`validateTopology: valid=${valid}, errors=${errors.length}, warnings=${warnings.length}, coverage=${(connectivityCoverage * 100).toFixed(1)}%`);
}

export { validateTopology };
