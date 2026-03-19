/**
 * Model Validation — consolidated semantic, geometric, topological, and structural validators.
 *
 * Runs all 4 validators against the resolved model, computes readiness score,
 * evaluates gates, and builds the full validation report.
 *
 * Merged from builting-validate/{semantic,geometric,topological,structural}.mjs
 * into the Topology Engine so validation runs in the same memory context as
 * structure/geometry — no S3 serialization boundary.
 */

import {
  TOLERANCES, CONFIDENCE, ALLOWED_SEMANTIC_TYPES, DOMAIN_MINIMUMS,
  GENERIC_NAME_PATTERNS, UNRESOLVED_CONTAINER_SEVERITY, CROSS_DOMAIN_SUSPICIOUS,
  WALL_LIKE_TYPES, WALL_LIKE_SEMANTIC_TYPES, TUNNEL_SHELL_ROLES,
  CHECK_SEVERITY, BLOCKS_EXPORT_CHECKS
} from './config.mjs';
import { evaluateReadiness } from './readiness.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

let semIssueCounter = 0;

function makeSemIssue(check, elementIds, message, impact = 'semantic') {
  return {
    issue_id: `sem-${String(++semIssueCounter).padStart(4, '0')}`,
    category: 'semantic',
    severity: CHECK_SEVERITY[check] || 'warning',
    impact, check, element_ids: elementIds, message,
    auto_repaired: false, blocks_export: BLOCKS_EXPORT_CHECKS.has(check)
  };
}

export function validateSemantic(resolved) {
  semIssueCounter = 0;
  const issues = [];
  const domain = (resolved.domain || 'BUILDING').toUpperCase();
  const elements = resolved.elements || [];

  let high = 0, medium = 0, low = 0;
  let proxyCount = 0, genericNameCount = 0, typeAlignmentIssueCount = 0;
  let domainCompliance = true;

  const suspiciousTypes = CROSS_DOMAIN_SUSPICIOUS[domain] || [];
  const genericPatterns = new Set(GENERIC_NAME_PATTERNS.map(p => p.toLowerCase()));

  for (const elem of elements) {
    const conf = elem.confidence ?? 0.7;
    const type = (elem.type || 'UNKNOWN').toUpperCase();
    const semType = elem.semanticType || 'IfcBuildingElementProxy';
    const name = (elem.name || '').trim();
    const canonId = elem.canonical_id || elem.element_key || 'unknown';

    if (conf >= CONFIDENCE.HIGH) high++;
    else if (conf >= CONFIDENCE.MEDIUM) medium++;
    else {
      low++;
      issues.push(makeSemIssue('low_confidence', [canonId],
        `Element "${name || canonId}" has low confidence ${conf.toFixed(2)}`));
    }

    if (semType === 'IfcBuildingElementProxy') proxyCount++;

    const allowedForType = ALLOWED_SEMANTIC_TYPES[type];
    if (allowedForType && !allowedForType.includes(semType)) {
      typeAlignmentIssueCount++;
      issues.push(makeSemIssue('type_semantic_mismatch', [canonId],
        `Type ${type} has semanticType "${semType}" which is not in allowed set [${allowedForType.join(', ')}]`));
    }

    if (genericPatterns.has(name.toLowerCase())) {
      genericNameCount++;
      issues.push(makeSemIssue('generic_name', [canonId],
        `Element has generic name "${name || '(empty)'}"`));
    }

    if (suspiciousTypes.includes(type)) {
      domainCompliance = false;
      issues.push(makeSemIssue('cross_domain_entity', [canonId],
        `Type ${type} is suspicious for domain ${domain}`, 'generator'));
    }

    if (semType === 'IfcBuildingElementProxy' && type !== 'PROXY' && type !== 'UNKNOWN') {
      issues.push(makeSemIssue('unresolved_semantic_class', [canonId],
        `Type ${type} resolved to IfcBuildingElementProxy — semantics unresolved`));
    }
  }

  const proxyRatio = elements.length > 0 ? proxyCount / elements.length : 0;

  return {
    summary: {
      confidenceDist: { high, medium, low },
      proxyCount,
      proxyRatio: Math.round(proxyRatio * 1000) / 1000,
      domainCompliance, genericNameCount, typeAlignmentIssueCount
    },
    issues
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRIC VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

let geomIssueCounter = 0;

function makeGeomIssue(check, elementIds, message, impact = 'viewer') {
  return {
    issue_id: `geom-${String(++geomIssueCounter).padStart(4, '0')}`,
    category: 'geometric',
    severity: CHECK_SEVERITY[check] || 'warning',
    impact, check, element_ids: elementIds, message,
    auto_repaired: false, blocks_export: BLOCKS_EXPORT_CHECKS.has(check)
  };
}

function isFiniteVec(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function vecLength(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function crossMagnitude(a, b) {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

export function validateGeometric(resolved) {
  geomIssueCounter = 0;
  const issues = [];
  const elements = resolved.elements || [];

  let nanCount = 0, outOfBoundsCount = 0, invalidDimensionCount = 0;
  let invalidPlacementCount = 0, localFrameIssueCount = 0, meshIssueCount = 0;
  let suspiciousCoincidentPlacementCount = 0;
  let sweepCount = 0, revolutionCount = 0, curveApproxCount = 0;

  const methodDist = {};
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const positionMap = new Map();

  for (const elem of elements) {
    const canonId = elem.canonical_id || elem.element_key || 'unknown';
    const p = elem.placement;
    const g = elem.geometry;

    if (p) {
      const origin = p.origin;
      const axis = p.axis;
      const refDir = p.refDirection;

      if (!isFiniteVec(origin)) {
        nanCount++;
        issues.push(makeGeomIssue('invalid_origin', [canonId],
          `Placement origin is NaN/Inf: (${origin?.x}, ${origin?.y}, ${origin?.z})`, 'generator'));
      } else {
        minX = Math.min(minX, origin.x); maxX = Math.max(maxX, origin.x);
        minY = Math.min(minY, origin.y); maxY = Math.max(maxY, origin.y);
        minZ = Math.min(minZ, origin.z); maxZ = Math.max(maxZ, origin.z);

        if (Math.abs(origin.x) > TOLERANCES.MAX_COORD ||
            Math.abs(origin.y) > TOLERANCES.MAX_COORD ||
            Math.abs(origin.z) > TOLERANCES.MAX_COORD) {
          outOfBoundsCount++;
          issues.push(makeGeomIssue('out_of_bounds', [canonId],
            `Placement at (${origin.x.toFixed(1)}, ${origin.y.toFixed(1)}, ${origin.z.toFixed(1)}) exceeds ±${TOLERANCES.MAX_COORD}m`));
        }
      }

      if (origin && (typeof origin.x !== 'number' || typeof origin.y !== 'number' || typeof origin.z !== 'number')) {
        invalidPlacementCount++;
        issues.push(makeGeomIssue('placement_not_numeric', [canonId],
          `Placement origin contains non-numeric values`, 'generator'));
      }

      if (axis) {
        if (!isFiniteVec(axis)) {
          localFrameIssueCount++;
          issues.push(makeGeomIssue('invalid_axis', [canonId],
            `Axis vector is non-finite: (${axis.x}, ${axis.y}, ${axis.z})`, 'generator'));
        } else if (vecLength(axis) < TOLERANCES.MIN_VECTOR_LENGTH) {
          localFrameIssueCount++;
          issues.push(makeGeomIssue('invalid_axis', [canonId],
            `Axis vector is zero-length`, 'generator'));
        }
      }

      if (refDir) {
        if (!isFiniteVec(refDir)) {
          localFrameIssueCount++;
          issues.push(makeGeomIssue('invalid_refDirection', [canonId],
            `RefDirection vector is non-finite: (${refDir.x}, ${refDir.y}, ${refDir.z})`, 'generator'));
        } else if (vecLength(refDir) < TOLERANCES.MIN_VECTOR_LENGTH) {
          localFrameIssueCount++;
          issues.push(makeGeomIssue('invalid_refDirection', [canonId],
            `RefDirection vector is zero-length`, 'generator'));
        }
      }

      if (axis && refDir && isFiniteVec(axis) && isFiniteVec(refDir) &&
          vecLength(axis) >= TOLERANCES.MIN_VECTOR_LENGTH &&
          vecLength(refDir) >= TOLERANCES.MIN_VECTOR_LENGTH) {
        const crossMag = crossMagnitude(axis, refDir);
        const product = vecLength(axis) * vecLength(refDir);
        if (product > 0 && crossMag / product < TOLERANCES.COLLINEARITY_TOLERANCE) {
          localFrameIssueCount++;
          issues.push(makeGeomIssue('collinear_axis_refDirection', [canonId],
            `Axis and refDirection are collinear (cross product magnitude: ${(crossMag / product).toFixed(6)})`, 'generator'));
        }
      }
    }

    if (g) {
      const method = g.method || g.intent || 'UNKNOWN';
      methodDist[method] = (methodDist[method] || 0) + 1;

      if (g.profile) {
        const w = g.profile.width;
        const h = g.profile.height;
        if (w !== undefined && w !== null && (typeof w !== 'number' || w <= 0)) {
          invalidDimensionCount++;
          issues.push(makeGeomIssue('invalid_profile', [canonId],
            `Profile width must be > 0, got ${w}`, 'generator'));
        }
        if (h !== undefined && h !== null && (typeof h !== 'number' || h <= 0)) {
          invalidDimensionCount++;
          issues.push(makeGeomIssue('invalid_profile', [canonId],
            `Profile height must be > 0, got ${h}`, 'generator'));
        }
      }

      if (g.depth !== undefined && g.depth !== null) {
        if (typeof g.depth !== 'number' || g.depth <= 0) {
          issues.push(makeGeomIssue('invalid_depth', [canonId],
            `Extrusion depth must be > 0, got ${g.depth}`, 'generator'));
        }
      }

      const w = g.profile?.width || 0;
      const h = g.profile?.height || 0;
      const d = g.depth || 0;
      if (w > TOLERANCES.MAX_DIMENSION || h > TOLERANCES.MAX_DIMENSION || d > TOLERANCES.MAX_DIMENSION) {
        issues.push(makeGeomIssue('oversized_dimension', [canonId],
          `Oversized geometry: ${w.toFixed(1)} x ${h.toFixed(1)} x ${d.toFixed(1)} exceeds ${TOLERANCES.MAX_DIMENSION}m`));
      }

      const hasVertices = Array.isArray(g.vertices) && g.vertices.length > 0;
      const hasFaces = Array.isArray(g.faces) && g.faces.length > 0;

      if (hasFaces && !hasVertices) {
        meshIssueCount++;
        issues.push(makeGeomIssue('mesh_missing_vertices', [canonId],
          `Mesh has ${g.faces.length} faces but no vertices`, 'generator'));
      }
      if (hasVertices && !hasFaces) {
        meshIssueCount++;
        issues.push(makeGeomIssue('mesh_missing_faces', [canonId],
          `Mesh has ${g.vertices.length} vertices but no faces`, 'generator'));
      }

      if (hasVertices && hasFaces) {
        const vertCount = g.vertices.length;
        let hasOobIndex = false;
        let hasDegen = false;

        for (const face of g.faces) {
          if (!Array.isArray(face)) continue;
          if (face.length < 3) {
            if (!hasDegen) {
              hasDegen = true;
              meshIssueCount++;
              issues.push(makeGeomIssue('degenerate_mesh_face', [canonId],
                `Mesh face has < 3 indices`));
            }
          }
          for (const idx of face) {
            if (typeof idx === 'number' && idx >= vertCount) {
              if (!hasOobIndex) {
                hasOobIndex = true;
                meshIssueCount++;
                issues.push(makeGeomIssue('mesh_face_index_out_of_bounds', [canonId],
                  `Mesh face index ${idx} >= vertex count ${vertCount}`, 'generator'));
              }
            }
          }
        }

        let meshMinX = Infinity, meshMaxX = -Infinity;
        let meshMinY = Infinity, meshMaxY = -Infinity;
        let meshMinZ = Infinity, meshMaxZ = -Infinity;
        for (const v of g.vertices) {
          if (Array.isArray(v) && v.length >= 3) {
            meshMinX = Math.min(meshMinX, v[0]); meshMaxX = Math.max(meshMaxX, v[0]);
            meshMinY = Math.min(meshMinY, v[1]); meshMaxY = Math.max(meshMaxY, v[1]);
            meshMinZ = Math.min(meshMinZ, v[2]); meshMaxZ = Math.max(meshMaxZ, v[2]);
          }
        }
        if (!Number.isFinite(meshMinX) || !Number.isFinite(meshMaxX)) {
          meshIssueCount++;
          issues.push(makeGeomIssue('mesh_invalid_bbox', [canonId],
            `Mesh bounding box is not finite`));
        }
      }

      if (method === 'SWEEP') {
        sweepCount++;
        const pathPts = g.pathPoints;
        if (!Array.isArray(pathPts) || pathPts.length < 2) {
          issues.push(makeGeomIssue('sweep_missing_path', [canonId],
            `SWEEP method requires pathPoints with >= 2 points, got ${Array.isArray(pathPts) ? pathPts.length : 0}`, 'generator'));
        }
        const radius = g.profile?.radius;
        if (radius === undefined || radius === null || typeof radius !== 'number' || radius <= 0) {
          issues.push(makeGeomIssue('sweep_invalid_radius', [canonId],
            `SWEEP requires positive radius, got ${radius}`, 'generator'));
        }
      }

      if (method === 'REVOLUTION') {
        revolutionCount++;
        if (!g.revolutionAxis) {
          issues.push(makeGeomIssue('revolution_missing_axis', [canonId],
            'REVOLUTION method requires a revolutionAxis', 'generator'));
        }
        const angle = g.revolutionAngle;
        if (angle === undefined || angle === null || typeof angle !== 'number' || angle <= 0 || angle > 360) {
          issues.push(makeGeomIssue('revolution_invalid_angle', [canonId],
            `REVOLUTION angle must be 0-360, got ${angle}`, 'generator'));
        }
        if (!g.profile) {
          issues.push(makeGeomIssue('revolution_missing_profile', [canonId],
            'REVOLUTION method requires a profile definition', 'generator'));
        }
      }

      if (g.profile?.type === 'ARBITRARY' && Array.isArray(g.profile?.points) && g.profile.points.length > 8) {
        const approxHint = g.geometryApproximation || g._previousMethod || '';
        const curvedIntent = (elem.properties?.shape || '').toLowerCase().includes('circular') ||
                             (elem.properties?.shape || '').toLowerCase().includes('horseshoe') ||
                             approxHint.includes('CIRCULAR') || approxHint.includes('HORSESHOE') ||
                             g._previousMethod === 'SWEEP' || g._previousMethod === 'REVOLUTION';
        if (curvedIntent) {
          curveApproxCount++;
          issues.push(makeGeomIssue('curve_approximated_as_polygon', [canonId],
            `Curved geometry approximated with ${g.profile.points.length}-point polygon instead of native curve`, 'quality'));
        }
      }
    }

    if (p?.origin && isFiniteVec(p.origin)) {
      const type = (elem.type || 'UNKNOWN').toUpperCase();
      const px = Math.round(p.origin.x / TOLERANCES.PROXIMITY_TOLERANCE);
      const py = Math.round(p.origin.y / TOLERANCES.PROXIMITY_TOLERANCE);
      const pz = Math.round(p.origin.z / TOLERANCES.PROXIMITY_TOLERANCE);
      const posKey = `${px},${py},${pz},${type}`;

      if (positionMap.has(posKey)) {
        const existing = positionMap.get(posKey);
        const hasRelation = (elem.relationships || []).some(r =>
          (r.type === 'HOSTED_BY' || r.type === 'VOIDS' || r.type === 'CONTAINS') &&
          r.target === existing.canonical_id
        ) || (existing.relationships || []).some(r =>
          (r.type === 'HOSTED_BY' || r.type === 'VOIDS' || r.type === 'CONTAINS') &&
          r.target === canonId
        );

        if (!hasRelation) {
          suspiciousCoincidentPlacementCount++;
          issues.push(makeGeomIssue('suspicious_coincident_placement', [canonId, existing.canonical_id],
            `Same type ${type} at coincident position with no host/containment relationship`));
        }
      } else {
        positionMap.set(posKey, { canonical_id: canonId, relationships: elem.relationships });
      }
    }
  }

  const extentX = Number.isFinite(maxX - minX) ? Math.round((maxX - minX) * 100) / 100 : 0;
  const extentY = Number.isFinite(maxY - minY) ? Math.round((maxY - minY) * 100) / 100 : 0;
  const extentZ = Number.isFinite(maxZ - minZ) ? Math.round((maxZ - minZ) * 100) / 100 : 0;

  const totalElements = Math.max(elements.length, 1);
  const geometryFidelity = {
    nativeCurveRatio: (sweepCount + revolutionCount) / totalElements,
    polygonApproxRatio: curveApproxCount / totalElements,
    sweepCount, revolutionCount, curveApproxCount,
  };

  return {
    summary: {
      boundsMin: Number.isFinite(minX) ? { x: Math.round(minX * 100) / 100, y: Math.round(minY * 100) / 100, z: Math.round(minZ * 100) / 100 } : null,
      boundsMax: Number.isFinite(maxX) ? { x: Math.round(maxX * 100) / 100, y: Math.round(maxY * 100) / 100, z: Math.round(maxZ * 100) / 100 } : null,
      modelExtent: { x: extentX, y: extentY, z: extentZ },
      methodDist, nanCount, outOfBoundsCount, invalidDimensionCount,
      suspiciousCoincidentPlacementCount, meshIssueCount,
      invalidPlacementCount, localFrameIssueCount, geometryFidelity
    },
    issues
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOPOLOGICAL VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

let topoIssueCounter = 0;

function makeTopoIssue(check, elementIds, message, impact = 'topology') {
  return {
    issue_id: `topo-${String(++topoIssueCounter).padStart(4, '0')}`,
    category: 'topological',
    severity: CHECK_SEVERITY[check] || 'warning',
    impact, check, element_ids: elementIds, message,
    auto_repaired: false, blocks_export: BLOCKS_EXPORT_CHECKS.has(check)
  };
}

export function validateTopological(resolved) {
  topoIssueCounter = 0;
  const issues = [];
  const elements = resolved.elements || [];
  const containers = resolved.containers || [];
  const topology = resolved.topology || {};
  const domain = (resolved.domain || 'BUILDING').toUpperCase();
  const isLinear = ['TUNNEL', 'LINEAR'].includes(domain);

  const containerIds = new Set(containers.map(c => c.id));
  const elemByKey = new Map();
  const elemByCanonId = new Map();
  for (const e of elements) {
    const key = e.element_key || e.canonical_id;
    if (key) elemByKey.set(key, e);
    if (e.canonical_id) elemByCanonId.set(e.canonical_id, e);
  }
  const allElementIds = new Set([...elemByKey.keys(), ...elemByCanonId.keys()]);

  let validContainers = 0, unresolvedContainers = 0, invalidContainers = 0;

  for (const elem of elements) {
    const canonId = elem.canonical_id || elem.element_key || 'unknown';
    const type = (elem.type || 'UNKNOWN').toUpperCase();

    if (elem.container) {
      if (containerIds.has(elem.container)) validContainers++;
      else {
        invalidContainers++;
        issues.push(makeTopoIssue('invalid_container_ref', [canonId],
          `Container "${elem.container}" does not exist in containers list`));
      }
    } else if (elem.unresolvedContainer === true) {
      unresolvedContainers++;
      const severity = UNRESOLVED_CONTAINER_SEVERITY[type] || 'warning';
      const issue = makeTopoIssue('null_container_unresolved', [canonId],
        `Null container with unresolvedContainer flag (type: ${type})`);
      issue.severity = severity;
      issues.push(issue);
    } else {
      invalidContainers++;
      issues.push(makeTopoIssue('null_container_no_flag', [canonId],
        `Null container without unresolvedContainer flag (type: ${type})`));
    }
  }

  let validRelationships = 0, danglingRelationships = 0, selfRefCount = 0;

  for (const elem of elements) {
    const canonId = elem.canonical_id || elem.element_key || 'unknown';
    const elemKey = elem.element_key || elem.canonical_id;

    for (const rel of (elem.relationships || [])) {
      if (rel.target === elemKey || rel.target === canonId) {
        selfRefCount++;
        issues.push(makeTopoIssue('self_referential_relationship', [canonId],
          `Self-referential ${rel.type} relationship`));
        continue;
      }

      if (!allElementIds.has(rel.target)) {
        danglingRelationships++;
        issues.push(makeTopoIssue('dangling_relationship_target', [canonId],
          `${rel.type} target "${rel.target}" not found in element set`));
        continue;
      }

      validRelationships++;

      if (rel.type === 'VOIDS') {
        const target = elemByKey.get(rel.target) || elemByCanonId.get(rel.target);
        if (target) {
          const targetType = (target.type || '').toUpperCase();
          const targetSem = target.semanticType || '';
          if (!WALL_LIKE_TYPES.includes(targetType) && !WALL_LIKE_SEMANTIC_TYPES.includes(targetSem)) {
            issues.push(makeTopoIssue('invalid_opening_host_type', [canonId],
              `VOIDS target "${rel.target}" is type ${targetType}/${targetSem}, not a wall-like element`, 'authoring'));
          }
        }
      }
    }

    const rels = elem.relationships || [];
    const hostedByTargets = new Set(rels.filter(r => r.type === 'HOSTED_BY').map(r => r.target));
    const voidsTargets = rels.filter(r => r.type === 'VOIDS').map(r => r.target);
    for (const vt of voidsTargets) {
      if (hostedByTargets.has(vt)) {
        issues.push(makeTopoIssue('contradictory_relationships', [canonId],
          `Both HOSTED_BY and VOIDS on same target "${vt}"`, 'authoring'));
      }
    }
  }

  const openings = elements.filter(e =>
    e.type === 'DOOR' || e.type === 'WINDOW' ||
    e.semanticType === 'IfcDoor' || e.semanticType === 'IfcWindow'
  );
  let hostedOpenings = 0, orphanedOpenings = 0;

  for (const opening of openings) {
    const canonId = opening.canonical_id || opening.element_key || 'unknown';
    const hasVoids = (opening.relationships || []).some(r => r.type === 'VOIDS');
    if (hasVoids) hostedOpenings++;
    else {
      orphanedOpenings++;
      issues.push(makeTopoIssue('orphaned_opening', [canonId],
        `Opening "${opening.name || canonId}" has no VOIDS relationship — no host`, 'authoring'));
    }
  }

  const nodes = topology.nodes || [];
  const runs = topology.runs || [];
  let degree2Nodes = 0, connectedDegree2Nodes = 0;

  for (const node of nodes) {
    if (node.degree !== 2) continue;
    degree2Nodes++;

    const uniqueBranches = [...new Set(node.connectedBranches || [])];
    if (uniqueBranches.length !== 2) continue;

    let hasConnection = false;

    if (isLinear) {
      const branchRuns = uniqueBranches.map(b => runs.find(r => r.branchKey === b)).filter(Boolean);
      if (branchRuns.length === 2) {
        const SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'];
        for (const role of SHELL_ROLES) {
          const aKey = branchRuns[0].shellPieces?.[role];
          const bKey = branchRuns[1].shellPieces?.[role];
          if (!aKey || !bKey) continue;
          const a = elemByKey.get(aKey);
          if (a?.relationships?.some(r => r.type === 'PATH_CONNECTS' && r.target === bKey)) {
            hasConnection = true;
            break;
          }
        }
      }
    } else {
      const runKeys = uniqueBranches.map(b => {
        const run = runs.find(r => r.branchKey === b);
        return run?.elementKey || run?.branchKey;
      }).filter(Boolean);

      if (runKeys.length === 2) {
        const elem = elemByKey.get(runKeys[0]);
        if (elem?.relationships?.some(r => r.type === 'PATH_CONNECTS' && r.target === runKeys[1])) {
          hasConnection = true;
        }
      }
    }

    if (hasConnection) connectedDegree2Nodes++;
    else {
      issues.push(makeTopoIssue('path_connects_missing', [node.id],
        `Degree-2 node ${node.id} has no PATH_CONNECTS between branches [${uniqueBranches.join(', ')}]`));
    }
  }

  const pathConnectsCoverage = degree2Nodes > 0 ? connectedDegree2Nodes / degree2Nodes : 1.0;

  const equipment = elements.filter(e =>
    e.type === 'EQUIPMENT' ||
    (e.semanticType && (e.semanticType.startsWith('IfcFlowTerminal') || e.semanticType.startsWith('IfcDistribution')))
  );
  let hostedEquipment = 0, unhostedEquipment = 0;

  for (const eq of equipment) {
    const canonId = eq.canonical_id || eq.element_key || 'unknown';
    const hasHosting = (eq.relationships || []).some(r => r.type === 'HOSTED_BY');
    const hasSpaceKey = eq.properties?.hostSpaceKey || eq.metadata?.hostSpaceKey;
    if (hasHosting || hasSpaceKey) hostedEquipment++;
    else {
      unhostedEquipment++;
      issues.push(makeTopoIssue('equipment_no_host', [canonId],
        `Equipment "${eq.name || canonId}" has no HOSTED_BY or hostSpaceKey`, 'authoring'));
    }
  }

  return {
    summary: {
      containerValidity: { valid: validContainers, unresolved: unresolvedContainers, invalid: invalidContainers },
      relationshipIntegrity: { valid: validRelationships, dangling: danglingRelationships, selfRef: selfRefCount },
      pathConnectsCoverage: Math.round(pathConnectsCoverage * 1000) / 1000,
      openingHosting: { hosted: hostedOpenings, orphaned: orphanedOpenings },
      equipmentHosting: { hosted: hostedEquipment, unhosted: unhostedEquipment }
    },
    issues
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

let structIssueCounter = 0;

function makeStructIssue(check, elementIds, message, impact = 'authoring') {
  return {
    issue_id: `struct-${String(++structIssueCounter).padStart(4, '0')}`,
    category: 'structural',
    severity: CHECK_SEVERITY[check] || 'warning',
    impact, check, element_ids: elementIds, message,
    auto_repaired: false, blocks_export: BLOCKS_EXPORT_CHECKS.has(check)
  };
}

function _isFiniteVec(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function _vecDist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function validateStructural(resolved) {
  structIssueCounter = 0;
  const issues = [];
  const elements = resolved.elements || [];
  const containers = resolved.containers || [];
  const topology = resolved.topology || {};
  const domain = (resolved.domain || 'BUILDING').toUpperCase();
  const isLinear = ['TUNNEL', 'LINEAR'].includes(domain);

  const typeCounts = {};
  for (const e of elements) {
    const t = (e.type || 'UNKNOWN').toUpperCase();
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  const wallCount = typeCounts['WALL'] || 0;
  const slabCount = typeCounts['SLAB'] || 0;
  const spaceCount = typeCounts['SPACE'] || 0;

  let domainRequirementsMet = true;
  const minimums = DOMAIN_MINIMUMS[domain] || {};

  for (const [type, minCount] of Object.entries(minimums)) {
    const actual = typeCounts[type] || 0;
    if (actual < minCount) {
      domainRequirementsMet = false;
      issues.push(makeStructIssue('domain_minimum_not_met', [],
        `Domain ${domain} requires ≥${minCount} ${type}, found ${actual}`, 'generator'));
    }
  }

  const containerPresence = containers.length > 0;
  if (!containerPresence) {
    issues.push(makeStructIssue('no_containers', [],
      `No containers (storeys/segments) defined`, 'generator'));
  }

  let shellNaming = { named: 0, generic: 0 };
  const runs = topology.runs || [];

  if (isLinear) {
    let hasAnyShell = false;
    for (const run of runs) {
      if (!run.shellPieces) continue;
      const presentRoles = Object.keys(run.shellPieces);
      if (presentRoles.length > 0) hasAnyShell = true;

      for (const role of TUNNEL_SHELL_ROLES) {
        if (run.shellPieces[role]) shellNaming.named++;
      }
      for (const role of presentRoles) {
        if (!TUNNEL_SHELL_ROLES.includes(role)) shellNaming.generic++;
      }
    }

    if (!hasAnyShell && runs.length > 0) {
      issues.push(makeStructIssue('missing_shell_pieces', [],
        `Tunnel has ${runs.length} runs but no shell pieces defined`));
    }
  }

  if (isLinear && shellNaming.generic > 0) {
    issues.push(makeStructIssue('shell_naming_inconsistent', [],
      `${shellNaming.generic} shell pieces use non-standard role names (expected: ${TUNNEL_SHELL_ROLES.join(', ')})`));
  }

  const openings = elements.filter(e =>
    e.type === 'DOOR' || e.type === 'WINDOW' ||
    e.semanticType === 'IfcDoor' || e.semanticType === 'IfcWindow'
  );
  const walls = elements.filter(e =>
    e.type === 'WALL' || e.semanticType === 'IfcWall' || e.semanticType === 'IfcWallStandardCase'
  );

  for (const opening of openings) {
    const canonId = opening.canonical_id || opening.element_key || 'unknown';
    const hasVoids = (opening.relationships || []).some(r => r.type === 'VOIDS');
    if (hasVoids) continue;

    const openingOrigin = opening.placement?.origin;
    if (!openingOrigin || !_isFiniteVec(openingOrigin)) continue;

    let closestWallDist = Infinity;
    for (const wall of walls) {
      const wallOrigin = wall.placement?.origin;
      if (!wallOrigin || !_isFiniteVec(wallOrigin)) continue;
      closestWallDist = Math.min(closestWallDist, _vecDist(openingOrigin, wallOrigin));
    }

    if (closestWallDist > 5.0) {
      issues.push(makeStructIssue('orphaned_opening_no_plausible_host', [canonId],
        `Opening "${opening.name || canonId}" has no VOIDS and nearest wall is ${closestWallDist.toFixed(1)}m away`));
    }
  }

  if (domain === 'BUILDING') {
    let disconnectedCount = 0;
    const envelopeElements = elements.filter(e => e.type === 'WALL' || e.type === 'SLAB');
    for (const e of envelopeElements) {
      const rels = e.relationships || [];
      const hasSpatialRel = rels.some(r =>
        r.type === 'PATH_CONNECTS' || r.type === 'VOIDS' || r.type === 'HOSTED_BY' || r.type === 'CONTAINS'
      );
      if (!hasSpatialRel) disconnectedCount++;
    }
    if (disconnectedCount > 0 && envelopeElements.length > 0) {
      const ratio = disconnectedCount / envelopeElements.length;
      if (ratio > 0.5) {
        issues.push(makeStructIssue('disconnected_envelope', [],
          `${disconnectedCount}/${envelopeElements.length} envelope elements have no spatial relationships`));
      }
    }
  }

  const mergedRuns = elements.filter(e => e.properties?.isMergedRun);
  for (const mr of mergedRuns) {
    const canonId = mr.canonical_id || mr.element_key || 'unknown';
    const hasPathConnect = (mr.relationships || []).some(r => r.type === 'PATH_CONNECTS');
    if (!hasPathConnect) {
      issues.push(makeStructIssue('merged_run_no_topology', [canonId],
        `Merged run "${mr.name || canonId}" has no PATH_CONNECTS relationship`));
    }
  }

  const structuralProxies = elements.filter(e =>
    e.type === 'PROXY' && !e.properties?.isTransitionHelper
  );
  for (const proxy of structuralProxies) {
    const canonId = proxy.canonical_id || proxy.element_key || 'unknown';
    if (!proxy.properties?.isProxyFallback) {
      issues.push(makeStructIssue('proxy_fallback_no_flag', [canonId],
        `Structural proxy "${proxy.name || canonId}" missing isProxyFallback flag`));
    }
  }

  const envelopeCoverage = (wallCount > 0 && slabCount > 0) ? 'partial' :
                           (wallCount > 0 || slabCount > 0) ? 'minimal' : 'none';
  const minEnvelopePass = domainRequirementsMet && containerPresence;

  return {
    summary: {
      domainRequirementsMet, wallCount, slabCount, spaceCount,
      shellNaming, minEnvelopePass, envelopeCoverage, containerPresence
    },
    issues
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FULL VALIDATION ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run all 4 validators + readiness evaluation on a resolved model.
 * Returns the full validation report ready for S3 serialization.
 */
export function runFullValidation(resolved) {
  const startTime = Date.now();
  const domain = (resolved.domain || 'BUILDING').toUpperCase();
  const elementCount = resolved.elements?.length || 0;
  const moduleDurations = {};

  let t0;

  t0 = Date.now();
  const semantic = validateSemantic(resolved);
  moduleDurations.semantic = Date.now() - t0;

  t0 = Date.now();
  const geometric = validateGeometric(resolved);
  moduleDurations.geometric = Date.now() - t0;

  t0 = Date.now();
  const topological = validateTopological(resolved);
  moduleDurations.topological = Date.now() - t0;

  t0 = Date.now();
  const structural = validateStructural(resolved);
  moduleDurations.structural = Date.now() - t0;

  t0 = Date.now();
  const readiness = evaluateReadiness(semantic, geometric, topological, structural);
  moduleDurations.readiness = Date.now() - t0;

  const allIssues = [
    ...semantic.issues,
    ...geometric.issues,
    ...topological.issues,
    ...structural.issues
  ];

  const totalIssues = allIssues.length;
  const errorCount = allIssues.filter(i => i.severity === 'error').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const infoCount = allIssues.filter(i => i.severity === 'info').length;
  const blocksExportCount = allIssues.filter(i => i.blocks_export).length;

  const durationMs = Date.now() - startTime;

  const report = {
    pipelineVersion: '3.0',
    validationVersion: '1.1',
    stage: 'topology_engine_validate',
    generatedAt: new Date().toISOString(),
    durationMs,
    moduleDurations,
    domain,
    elementCount,
    semantic: { summary: semantic.summary, issues: semantic.issues },
    geometric: { summary: geometric.summary, issues: geometric.issues },
    topological: { summary: topological.summary, issues: topological.issues },
    structural: { summary: structural.summary, issues: structural.issues },
    readiness: {
      score: readiness.score,
      gates: readiness.gates,
      failedHardGates: readiness.failedHardGates,
      failedSoftGates: readiness.failedSoftGates,
      exportReadiness: readiness.exportReadiness,
      authoringSuitability: readiness.authoringSuitability,
      generationModeRecommendation: readiness.generationModeRecommendation,
      recommendations: readiness.recommendations
    },
    summary: { totalIssues, errorCount, warningCount, infoCount, blocksExportCount }
  };

  return { report, readiness, semantic, geometric };
}
