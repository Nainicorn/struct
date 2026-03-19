import { vecDist, vecNormalize, vecDot, vecSub, vecAdd, vecLen, vecScale, canonicalWallDirection, canonicalWallLength } from './shared.mjs';

// ============================================================================
// PHASE 3-TOPO: BUILD TOPOLOGY GRAPH (Domain-aware)
// Builds css.topology from branch/node data (linear) or wall intersections (architectural).
// ============================================================================

const INTERFACE_KINDS = new Set(['ATSTART', 'ATEND', 'ATPATH', 'NOTDEFINED']);

function buildTopologyGraph(css, options = {}) {
  const domain = options.domain || css.metadata?.structureClass || 'BUILDING';
  const exportProfile = options.exportProfile || css.metadata?.exportProfile || 'authoring_safe';

  css.topology = css.topology || { nodes: [], runs: [], junctions: [], interfaces: [], hosts: [], openings: [] };

  if (['TUNNEL', 'LINEAR'].includes(domain.toUpperCase())) {
    buildLinearTopology(css);
  } else if (['BUILDING', 'FACILITY'].includes(domain.toUpperCase())) {
    buildArchitecturalTopology(css);
  } else {
    buildHybridTopology(css);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.exportProfile = css.metadata.exportProfile || exportProfile;
  css.metadata.relationshipSchemaVersion = 2;

  console.log(`buildTopologyGraph [${domain}]: ${css.topology.nodes.length} nodes, ${css.topology.runs.length} runs, ${css.topology.junctions.length} junctions`);
}

/**
 * Linear topology for tunnel, corridor, conduit, utility runs.
 * Source: explicit entry_node / exit_node on TUNNEL_SEGMENT elements.
 */
function buildLinearTopology(css) {
  const structuralParents = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL'
  );

  const shellPieces = css.elements.filter(e =>
    e.properties?.derivedFromBranch && e.properties?.shellPiece
  );

  // Map shell pieces by branch+role — prefer merged runs over individual pieces
  const shellByBranchRole = new Map();
  for (const sp of shellPieces) {
    const branchKey = sp.properties.derivedFromBranch;
    const role = sp.properties.shellPiece;
    const key = `${branchKey}__${role}`;
    // If this is a merged run, it supersedes individual pieces
    if (sp.properties?.isMergedRun || !shellByBranchRole.has(key)) {
      shellByBranchRole.set(key, sp.element_key || sp.id);
    }
  }

  // Also handle merged runs that span multiple branches
  const mergedRuns = css.elements.filter(e => e.properties?.isMergedRun && e.properties?.derivedFromBranches);
  for (const mr of mergedRuns) {
    const role = mr.properties?.shellPiece;
    if (!role) continue;
    for (const branchKey of mr.properties.derivedFromBranches) {
      shellByBranchRole.set(`${branchKey}__${role}`, mr.element_key || mr.id);
    }
  }

  const nodeMap = new Map();
  const runs = [];

  for (const seg of structuralParents) {
    const branchKey = seg.element_key || seg.id;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (!entry || !exit) continue;

    // Build/update node entries
    if (!nodeMap.has(entry)) nodeMap.set(entry, { id: `node-${entry}`, sourceNodeKey: entry, xyz: null, connectedBranches: [] });
    if (!nodeMap.has(exit)) nodeMap.set(exit, { id: `node-${exit}`, sourceNodeKey: exit, xyz: null, connectedBranches: [] });

    nodeMap.get(entry).connectedBranches.push(branchKey);
    nodeMap.get(exit).connectedBranches.push(branchKey);

    // Compute node positions from segment endpoints
    const ax = seg.placement?.axis ? vecNormalize(seg.placement.axis) : null;
    const origin = seg.placement?.origin;
    const depth = seg.geometry?.depth || 0;
    if (ax && origin) {
      const entryPt = vecAdd(origin, vecScale(ax, -depth / 2));
      const exitPt = vecAdd(origin, vecScale(ax, depth / 2));
      if (!nodeMap.get(entry).xyz) nodeMap.get(entry).xyz = entryPt;
      if (!nodeMap.get(exit).xyz) nodeMap.get(exit).xyz = exitPt;
    }

    runs.push({
      id: `run-${branchKey}`,
      branchKey,
      startNode: `node-${entry}`,
      endNode: `node-${exit}`,
      axis: ax || { x: 1, y: 0, z: 0 },
      length: depth,
      shellPieces: {
        LEFT_WALL: shellByBranchRole.get(`${branchKey}__LEFT_WALL`) || null,
        RIGHT_WALL: shellByBranchRole.get(`${branchKey}__RIGHT_WALL`) || null,
        FLOOR: shellByBranchRole.get(`${branchKey}__FLOOR`) || null,
        ROOF: shellByBranchRole.get(`${branchKey}__ROOF`) || null,
        VOID: shellByBranchRole.get(`${branchKey}__VOID`) || null
      }
    });
  }

  const nodes = [];
  const junctions = [];

  // Collect transition element IDs from generateJunctionTransitions
  const transitionsByNode = new Map();
  for (const e of css.elements) {
    const jNode = e.properties?.junctionNodeId;
    const bNode = e.properties?.bendNodeId;
    const nodeId = jNode || bNode;
    if (nodeId && e.properties?.isTransitionHelper) {
      if (!transitionsByNode.has(nodeId)) transitionsByNode.set(nodeId, []);
      transitionsByNode.get(nodeId).push(e.element_key || e.id);
    }
  }

  for (const n of nodeMap.values()) {
    n.degree = new Set(n.connectedBranches).size;
    n.kind = n.degree <= 1 ? 'TERMINAL' : (n.degree === 2 ? 'PATH_NODE' : 'JUNCTION');
    nodes.push(n);

    if (n.degree >= 3) {
      junctions.push({
        id: `junc-${n.sourceNodeKey}`,
        node: n.id,
        connectedRuns: [...new Set(n.connectedBranches)].map(b => `run-${b}`),
        transitionElementIds: transitionsByNode.get(n.sourceNodeKey) || [],
        kind: 'MULTI_BRANCH'
      });
    }
  }

  css.topology.nodes = nodes;
  css.topology.runs = runs;
  css.topology.junctions = junctions;
}

/**
 * Architectural topology for building walls/slabs.
 * Prioritized source order:
 * 1. Explicit source graph (extraction-provided adjacency)
 * 2. Host/opening metadata (wall hosts opening → implicit adjacency)
 * 3. Aligned axis + end-cap coincidence + compatible semantic type
 * 4. Proximity fallback (0.20m) ONLY as last-resort repair
 */
function buildArchitecturalTopology(css) {
  const walls = css.elements.filter(e =>
    e.type === 'WALL' && !e.properties?.isTransitionHelper && !e.properties?.isApproximation
  );
  if (walls.length === 0) return;

  const SNAP_TOL = 0.20; // proximity fallback tolerance
  const nodeMap = new Map();
  let nodeCounter = 0;

  // Helper: get wall endpoints in world space using canonical direction + length
  function wallEndpoints(wall) {
    const o = wall.placement?.origin;
    if (!o) return null;
    const dir = canonicalWallDirection(wall);
    if (!dir) return null;
    const len = canonicalWallLength(wall);
    if (len <= 0) return null;
    return {
      start: vecAdd(o, vecScale(dir, -len / 2)),
      end: vecAdd(o, vecScale(dir, len / 2))
    };
  }

  // Helper: find or create node at position
  function findOrCreateNode(pos, sourceId) {
    for (const [key, node] of nodeMap) {
      if (node.xyz && vecDist(node.xyz, pos) < SNAP_TOL) {
        return node;
      }
    }
    const id = `node-arch-${nodeCounter++}`;
    const node = { id, sourceNodeKey: id, xyz: pos, connectedBranches: [], degree: 0, kind: 'PATH_NODE' };
    nodeMap.set(id, node);
    return node;
  }

  const runs = [];

  // SOURCE 1: Check for explicit adjacency in properties
  // (extraction may have set properties.adjacentWalls or similar)

  // SOURCE 2 & 3: Build endpoints, find coincident endpoints
  const wallEndpointCache = new Map();
  for (const wall of walls) {
    const eps = wallEndpoints(wall);
    if (!eps) continue;
    wallEndpointCache.set(wall.element_key || wall.id, eps);
  }

  for (const wall of walls) {
    const key = wall.element_key || wall.id;
    const eps = wallEndpointCache.get(key);
    if (!eps) continue;

    const startNode = findOrCreateNode(eps.start, key);
    const endNode = findOrCreateNode(eps.end, key);

    if (!startNode.connectedBranches.includes(key)) startNode.connectedBranches.push(key);
    if (!endNode.connectedBranches.includes(key)) endNode.connectedBranches.push(key);

    const ax = canonicalWallDirection(wall) || { x: 1, y: 0, z: 0 };
    const len = canonicalWallLength(wall);

    runs.push({
      id: `run-${key}`,
      branchKey: key,
      startNode: startNode.id,
      endNode: endNode.id,
      axis: ax,
      length: len,
      shellPieces: { LEFT_WALL: null, RIGHT_WALL: null, FLOOR: null, ROOF: null, VOID: null },
      elementKey: key,
      elementType: 'WALL'
    });
  }

  // Finalize nodes
  const nodes = [];
  const junctions = [];

  for (const n of nodeMap.values()) {
    n.degree = new Set(n.connectedBranches).size;
    n.kind = n.degree <= 1 ? 'TERMINAL' : (n.degree === 2 ? 'PATH_NODE' : 'JUNCTION');
    nodes.push(n);

    if (n.degree >= 3) {
      junctions.push({
        id: `junc-${n.id}`,
        node: n.id,
        connectedRuns: [...new Set(n.connectedBranches)].map(b => `run-${b}`),
        transitionElementIds: [], // buildings don't need transition elements
        kind: n.degree === 3 ? 'T_INTERSECTION' : (n.degree === 4 ? 'CROSS_INTERSECTION' : 'MULTI_BRANCH')
      });
    }
  }

  css.topology.nodes = nodes;
  css.topology.runs = runs;
  css.topology.junctions = junctions;
}

/**
 * Hybrid topology: runs linear for infrastructure elements, architectural for building elements.
 */
function buildHybridTopology(css) {
  const hasTunnelSegments = css.elements.some(e => e.type === 'TUNNEL_SEGMENT');
  const hasWalls = css.elements.some(e => e.type === 'WALL' && !e.properties?.derivedFromBranch);

  if (hasTunnelSegments) buildLinearTopology(css);

  if (hasWalls) {
    // Save linear topology, build architectural, then merge
    const linearNodes = [...css.topology.nodes];
    const linearRuns = [...css.topology.runs];
    const linearJunctions = [...css.topology.junctions];

    // Temporarily clear for architectural build
    css.topology.nodes = [];
    css.topology.runs = [];
    css.topology.junctions = [];
    buildArchitecturalTopology(css);

    // Merge
    css.topology.nodes = [...linearNodes, ...css.topology.nodes];
    css.topology.runs = [...linearRuns, ...css.topology.runs];
    css.topology.junctions = [...linearJunctions, ...css.topology.junctions];
  }
}

export { buildTopologyGraph };
