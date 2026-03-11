import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import pdf from 'pdf-parse';
import { extractXlsxText } from './parsers/xlsxParser.mjs';
import { extractDocxText } from './parsers/docxParser.mjs';
import { parseDxfToCSS } from './parsers/dxfParser.mjs';

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});

// ============================================================================
// UTILITY: Save CSS to S3 (avoids Step Function 256KB state limit)
// ============================================================================

async function saveCSSToS3(bucket, userId, renderId, css) {
  const key = `uploads/${userId}/${renderId}/css/css_raw.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(css),
    ContentType: 'application/json'
  }));
  console.log(`CSS saved to S3: s3://${bucket}/${key} (${JSON.stringify(css).length} bytes)`);
  return key;
}

// ============================================================================
// UTILITY: Deterministic Element ID
// ============================================================================

function elemId(geometry, placement) {
  const data = JSON.stringify({ geometry, placement });
  return 'elem-' + createHash('sha256').update(data).digest('hex').slice(0, 12);
}

// ============================================================================
// FILE DOWNLOAD
// ============================================================================

async function downloadFile(bucket, key) {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    const ext = key.toLowerCase().split('.').pop();
    const fileName = key.split('/').pop();

    if (ext === 'txt') {
      return { content: await response.Body.transformToString(), type: 'text' };
    } else if (ext === 'pdf') {
      try {
        const buffer = await response.Body.transformToByteArray();
        const data = await pdf(Buffer.from(buffer));
        return { content: data.text, type: 'text' };
      } catch (err) {
        console.warn(`Failed to extract text from PDF ${key}:`, err.message);
        return { content: null, type: 'unsupported', reason: err.message };
      }
    } else if (ext === 'xlsx' || ext === 'xls') {
      const buffer = Buffer.from(await response.Body.transformToByteArray());
      const text = extractXlsxText(buffer, fileName);
      return {
        content: text,
        type: 'text',
        contentType: 'text/plain; extracted-from=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };
    } else if (ext === 'docx') {
      const buffer = Buffer.from(await response.Body.transformToByteArray());
      const text = await extractDocxText(buffer, fileName);
      return {
        content: text,
        type: 'text',
        contentType: 'text/plain; extracted-from=application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      };
    } else if (ext === 'dxf') {
      return { content: await response.Body.transformToString(), type: 'text', contentType: 'text/dxf' };
    } else {
      return { content: null, type: 'unsupported', reason: `Unsupported format: ${ext}` };
    }
  } catch (err) {
    console.warn(`Failed to download ${key}:`, err.message);
    return { content: null, type: 'error', reason: err.message };
  }
}

// ============================================================================
// VENTSIM PARSER — outputs CSS format
// ============================================================================

function isVentSim(content) {
  return content.includes('KFACTORS') && content.includes('MAIN') && content.includes('6.0.4');
}

function parseVentSimToCSS(content, sourceFileName) {
  console.log('Parsing VentSim format to CSS...');

  try {
    const lines = content.split('\n');

    // Find MAIN section
    let mainStartIdx = -1;
    let mainEndIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('MAIN')) mainStartIdx = i;
      if (mainStartIdx !== -1 && (line.startsWith('END\tMAIN') || line === 'END MAIN')) {
        mainEndIdx = i;
        break;
      }
    }

    if (mainStartIdx === -1 || mainEndIdx === -1) {
      console.warn('MAIN section not found in VentSim file');
      return null;
    }

    // Parse header — the MAIN line itself contains tab-separated column names after "MAIN\t"
    const mainLineStr = lines[mainStartIdx];
    const headerCols = mainLineStr.split('\t');
    const colIndex = {};
    headerCols.forEach((header, idx) => {
      if (idx > 0) colIndex[header.trim()] = idx; // data rows have a row-index at col 0, so header[N] aligns with data[N]
    });

    // Extract branches
    const branches = [];
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (let i = mainStartIdx + 1; i < mainEndIdx; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split('\t');
      const branch = {
        unique_no: parseInt(cols[colIndex['Unique No']] || cols[0]) || 0,
        name: cols[colIndex['Branch Name']] || `Branch_${i}`,
        entry_node: cols[colIndex['Entry Node']] || '',
        exit_node: cols[colIndex['Exit Node']] || '',
        x1: parseFloat(cols[colIndex['X1']] || cols[9]) || 0,
        y1: parseFloat(cols[colIndex['Y1']] || cols[10]) || 0,
        z1: parseFloat(cols[colIndex['Z1']] || cols[11]) || 0,
        x2: parseFloat(cols[colIndex['X2']] || cols[12]) || 0,
        y2: parseFloat(cols[colIndex['Y2']] || cols[13]) || 0,
        z2: parseFloat(cols[colIndex['Z2']] || cols[14]) || 0,
        width: parseFloat(cols[colIndex['Width']] || cols[15]) || 1.0,
        height: parseFloat(cols[colIndex['Height']] || cols[16]) || 1.0,
        area: parseFloat(cols[colIndex['Area']] || cols[17]) || 1.0,
        shape_type: parseInt(cols[colIndex['Shape Type']] || cols[18]) || 0,
        fan_type: parseInt(cols[colIndex['Fan Type']] || cols[29]) || 0,
        fan_numbers: parseInt(cols[colIndex['Fan Numbers']] || cols[30]) || 0,
        liner_type: parseInt(cols[colIndex['Liner Type']] || cols[35]) || 1
      };

      minX = Math.min(minX, branch.x1, branch.x2);
      maxX = Math.max(maxX, branch.x1, branch.x2);
      minY = Math.min(minY, branch.y1, branch.y2);
      maxY = Math.max(maxY, branch.y1, branch.y2);
      minZ = Math.min(minZ, branch.z1, branch.z2);
      maxZ = Math.max(maxZ, branch.z1, branch.z2);

      branches.push(branch);
    }

    console.log(`Extracted ${branches.length} tunnel branches`);

    // Parse FANS section — each fan has a header line followed by curve data points.
    // Header: id \t name \t diameter \t ...  (name is non-empty text, not "0")
    // Curve:  index \t 0 \t pressure \t ...  (cols[1] is "0")
    const fans = [];
    const fansStartIdx = lines.findIndex(l => l.trim().startsWith('FANS'));
    if (fansStartIdx !== -1) {
      const fansEndIdx = lines.findIndex((l, i) => i > fansStartIdx && (l.trim().startsWith('END\tFANS') || l.trim() === 'END FANS'));
      for (let i = fansStartIdx + 1; i < fansEndIdx; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('END')) break;
        const cols = line.split('\t');
        // Fan header lines have an actual name in cols[1] (not just "0" or empty)
        if (cols.length > 2 && cols[1] && cols[1] !== '0' && /[a-zA-Z]/.test(cols[1])) {
          fans.push({
            fan_id: parseInt(cols[0]) || 0,
            name: cols[1].replace(/\|/g, '').trim() || `Fan_${cols[0]}`,
            diameter: parseFloat(cols[2]) || 1.0
          });
        }
        // Skip curve data points (cols[1] === "0")
      }
    }

    console.log(`Extracted ${fans.length} fans`);

    // Named spaces
    const namedSpaces = {};
    branches.forEach(b => {
      if (b.name && !b.name.startsWith('Branch_')) {
        if (!namedSpaces[b.name]) namedSpaces[b.name] = [];
        namedSpaces[b.name].push(b);
      }
    });

    // Build CSS segments from unique entry/exit node pairs
    const nodeSet = new Set();
    branches.forEach(b => { nodeSet.add(b.entry_node); nodeSet.add(b.exit_node); });

    // Create a single SEGMENT level for the tunnel network
    const segments = [{
      id: 'seg-tunnel-main',
      type: 'SEGMENT',
      name: 'Main Tunnel Network',
      startChainage_m: 0,
      endChainage_m: Math.max(maxX - minX, maxY - minY, 1)
    }];

    // Build CSS elements from branches
    const elements = [];
    const elementCounts = {};

    for (const branch of branches) {
      const dx = branch.x2 - branch.x1;
      const dy = branch.y2 - branch.y1;
      const dz = branch.z2 - branch.z1;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 0.01) continue;

      // Normalize direction
      const dirX = dx / length;
      const dirY = dy / length;
      const dirZ = dz / length;

      const isRound = branch.shape_type === 1;
      const linerMaterial = branch.liner_type === 1 ? 'concrete' : 'blasted_rock';

      // refDirection must not be parallel to the tunnel axis
      const absZ = Math.abs(dirZ);
      const refDirVec = absZ < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };

      // Normalize coordinates relative to bounding box origin so the model
      // sits near z=0 rather than at mine elevation (~1290m)
      const placement = {
        origin: { x: branch.x1 - minX, y: branch.y1 - minY, z: branch.z1 - minZ },
        axis: { x: dirX, y: dirY, z: dirZ },
        refDirection: refDirVec
      };

      // geometry.direction is in element-LOCAL space — local Z is already aligned
      // to the tunnel axis by the element placement above, so always extrude in (0,0,1)
      const geometry = isRound ? {
        method: 'EXTRUSION',
        profile: { type: 'CIRCLE', radius: branch.width / 2 },
        direction: { x: 0, y: 0, z: 1 },
        depth: length
      } : {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: branch.width, height: branch.height },
        direction: { x: 0, y: 0, z: 1 },
        depth: length
      };

      const id = elemId(geometry, placement);
      const branchName = branch.name || `Branch_${branch.unique_no}`;
      const element_key = `ventsim_branch_${branch.unique_no}`;
      const type = 'TUNNEL_SEGMENT';
      elementCounts[type] = (elementCounts[type] || 0) + 1;

      elements.push({
        id,
        element_key,
        type,
        semanticType: 'IfcBuildingElementProxy',
        name: branchName,
        placement,
        geometry,
        container: 'seg-tunnel-main',
        relationships: [],
        properties: {
          unique_no: branch.unique_no,
          entry_node: branch.entry_node,
          exit_node: branch.exit_node,
          area_m2: branch.area,
          liner_type: linerMaterial,
          shape: isRound ? 'round' : 'rectangular',
          fan_type: branch.fan_type,
          fan_numbers: branch.fan_numbers
        },
        material: {
          name: linerMaterial,
          color: linerMaterial === 'concrete' ? [0.75, 0.75, 0.75] : [0.55, 0.45, 0.35],
          transparency: 0
        },
        confidence: 0.95,
        source: 'VSM'
      });
    }

    // Add fan equipment elements
    for (let i = 0; i < fans.length; i++) {
      const fan = fans[i];
      // Place fans near the center of the normalized network
      const cx = (maxX - minX) / 2 + (i * 5);
      const cy = (maxY - minY) / 2;
      const cz = (maxZ - minZ) / 2;

      const placement = {
        origin: { x: cx, y: cy, z: cz },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: { x: 1, y: 0, z: 0 }
      };
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'CIRCLE', radius: fan.diameter / 2 },
        direction: { x: 0, y: 0, z: 1 },
        depth: fan.diameter
      };

      const id = elemId(geometry, placement);
      const element_key = `ventsim_fan_${fan.fan_id || i}`;
      elementCounts['EQUIPMENT'] = (elementCounts['EQUIPMENT'] || 0) + 1;

      elements.push({
        id,
        element_key,
        type: 'EQUIPMENT',
        semanticType: 'IfcFan',
        name: fan.name,
        placement,
        geometry,
        container: 'seg-tunnel-main',
        relationships: [],
        properties: {
          fan_id: fan.fan_id,
          diameter_m: fan.diameter
        },
        material: {
          name: 'steel',
          color: [0.5, 0.5, 0.55],
          transparency: 0
        },
        confidence: 0.9,
        source: 'VSM'
      });
    }

    // Named spaces are tracked in metadata but NOT rendered as separate geometry
    // (they were previously 10x5x5m hardcoded boxes that appeared as random blocks).
    // The tunnel branches themselves already represent named areas via their names.
    const spaceCount = Object.keys(namedSpaces).length;

    const branchCount = branches.length;
    const fanCount = fans.length;

    const css = {
      cssVersion: '1.0',
      domain: 'TUNNEL',
      facility: {
        name: 'Tunnel Network',
        type: 'tunnel',
        description: `Tunnel ventilation network with ${branchCount} branches, ${fanCount} fans, and ${spaceCount} named spaces. Network spans ${(maxX - minX).toFixed(1)}m x ${(maxY - minY).toFixed(1)}m with ${(maxZ - minZ).toFixed(1)}m elevation variation.`,
        units: 'M',
        crs: null,
        // Real-world offset recorded here; all element coords are normalized to 0-origin
        origin: { x: minX, y: minY, z: minZ },
        axes: 'RIGHT_HANDED_Z_UP'
      },
      levelsOrSegments: segments,
      elements,
      metadata: {
        sourceFiles: [{
          name: sourceFileName,
          parseStatus: 'success',
          role: 'geometry'
        }],
        outputMode: 'HYBRID',
        validationStatus: 'PENDING',
        unitNormalizationApplied: true,
        cssHash: null,
        elementCounts,
        bbox: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ }
        },
        repairLog: []
      }
    };

    return css;
  } catch (err) {
    console.error('Error parsing VentSim:', err.message);
    return null;
  }
}

// ============================================================================
// BEDROCK RESPONSE → CSS CONVERTER
// ============================================================================

function buildingSpecToCSS(spec, sourceFiles) {
  const dims = spec.dimensions || {};
  const length = dims.length_m || 20;
  const width = dims.width_m || 10;
  const height = dims.height_m || 3;
  const wallThickness = dims.wall_thickness_m || 0.3;
  const floorLevel = spec.elevations?.floor_level_m || 0;
  const numFloors = spec.structure?.num_floors || 1;
  const floorToFloor = spec.structure?.floor_to_floor_height_m || height;

  // Map buildingType to domain
  const domainMap = {
    'TUNNEL': 'TUNNEL', 'INDUSTRIAL': 'INDUSTRIAL', 'FACILITY': 'INDUSTRIAL',
    'CIVIL': 'CIVIL', 'STRUCTURAL': 'STRUCTURAL'
  };
  const domain = domainMap[spec.buildingType] || 'ARCH';

  // Build levels
  const levels = [];
  for (let f = 0; f < numFloors; f++) {
    levels.push({
      id: `level-${f + 1}`,
      type: 'STOREY',
      name: f === 0 ? 'Ground Floor' : `Floor ${f + 1}`,
      elevation_m: floorLevel + (f * floorToFloor),
      height_m: floorToFloor
    });
  }

  const elements = [];
  const elementCounts = {};

  function addElement(el) {
    elementCounts[el.type] = (elementCounts[el.type] || 0) + 1;
    elements.push(el);
  }

  // Helper for element creation
  function makeElement(type, semanticType, name, placement, geometry, container, props = {}, material = null, confidence = 0.7, source = 'LLM') {
    const id = elemId(geometry, placement);
    return { id, type, semanticType, name, placement, geometry, container, relationships: [], properties: props, material, confidence, source };
  }

  // ---- EXTERIOR WALLS (4 walls per floor) ----
  // NOTE: IfcRectangleProfileDef is centered at its placement origin, so each
  // wall's origin must be the centroid of that wall panel, not its corner.
  // Building footprint: X=[0, length], Y=[0, width]
  for (let f = 0; f < numFloors; f++) {
    const levelId = `level-${f + 1}`;
    const baseZ = floorLevel + (f * floorToFloor);
    const wt = wallThickness;

    // South wall: X=[0, length], Y=[0, wt] → centroid (length/2, wt/2)
    addElement(makeElement('WALL', 'IfcWallStandardCase', `South Wall F${f + 1}`,
      { origin: { x: length / 2, y: wt / 2, z: baseZ } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: wt }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'SOUTH' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    // North wall: X=[0, length], Y=[width-wt, width] → centroid (length/2, width-wt/2)
    addElement(makeElement('WALL', 'IfcWallStandardCase', `North Wall F${f + 1}`,
      { origin: { x: length / 2, y: width - wt / 2, z: baseZ } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: wt }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'NORTH' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    // West wall: X=[0, wt], Y=[0, width] → centroid (wt/2, width/2)
    addElement(makeElement('WALL', 'IfcWallStandardCase', `West Wall F${f + 1}`,
      { origin: { x: wt / 2, y: width / 2, z: baseZ } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: wt, height: width }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'WEST' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    // East wall: X=[length-wt, length], Y=[0, width] → centroid (length-wt/2, width/2)
    addElement(makeElement('WALL', 'IfcWallStandardCase', `East Wall F${f + 1}`,
      { origin: { x: length - wt / 2, y: width / 2, z: baseZ } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: wt, height: width }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'EAST' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    // Floor slab: X=[0, length], Y=[0, width] → centroid (length/2, width/2)
    addElement(makeElement('SLAB', 'IfcSlab', `Floor Slab F${f + 1}`,
      { origin: { x: length / 2, y: width / 2, z: baseZ } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: width }, direction: { x: 0, y: 0, z: 1 }, depth: 0.2 },
      levelId, { slabType: 'FLOOR' },
      { name: spec.materials?.floor || 'concrete', color: [0.6, 0.6, 0.6], transparency: 0 }
    ));

    // Roof slab (only on top floor): same footprint as floor
    if (f === numFloors - 1) {
      const roofZ = baseZ + floorToFloor;
      addElement(makeElement('SLAB', 'IfcSlab', 'Roof Slab',
        { origin: { x: length / 2, y: width / 2, z: roofZ } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: width }, direction: { x: 0, y: 0, z: 1 }, depth: 0.15 },
        levelId, { slabType: 'ROOF' },
        { name: spec.materials?.roof || 'metal', color: [0.4, 0.4, 0.45], transparency: 0 }
      ));
    }
  }

  // ---- INTERIOR WALLS ----
  if (spec.interior_walls) {
    for (const wall of spec.interior_walls) {
      const dx = (wall.x_end_m || 0) - (wall.x_start_m || 0);
      const dy = (wall.y_end_m || 0) - (wall.y_start_m || 0);
      const wallLength = Math.sqrt(dx * dx + dy * dy);
      if (wallLength < 0.01) continue;
      const thickness = wall.thickness_m || 0.15;

      const placement = { origin: { x: wall.x_start_m || 0, y: wall.y_start_m || 0, z: floorLevel } };
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: wallLength, height: thickness },
        direction: { x: 0, y: 0, z: 1 },
        depth: wall.height_m || floorToFloor
      };

      addElement(makeElement('WALL', 'IfcWallStandardCase', wall.name || 'Interior Wall',
        placement, geometry, 'level-1',
        { isExternal: false },
        { name: 'plasterboard', color: [0.9, 0.9, 0.88], transparency: 0 },
        0.65
      ));
    }
  }

  // ---- COLUMNS ----
  if (spec.structure?.column_grid) {
    for (const grid of spec.structure.column_grid) {
      const xSpacing = grid.x_spacing_m || 6;
      const ySpacing = grid.y_spacing_m || 6;
      const colSize = grid.column_size_m || 0.4;

      for (let x = xSpacing; x < length - wallThickness; x += xSpacing) {
        for (let y = ySpacing; y < width - wallThickness; y += ySpacing) {
          for (let f = 0; f < numFloors; f++) {
            const baseZ = floorLevel + (f * floorToFloor);
            const placement = { origin: { x: x + wallThickness, y: y + wallThickness, z: baseZ } };
            const geometry = {
              method: 'EXTRUSION',
              profile: { type: 'RECTANGLE', width: colSize, height: colSize },
              direction: { x: 0, y: 0, z: 1 },
              depth: floorToFloor
            };

            addElement(makeElement('COLUMN', 'IfcColumn', `Column ${x.toFixed(0)}-${y.toFixed(0)} F${f + 1}`,
              placement, geometry, `level-${f + 1}`,
              { gridX: x, gridY: y },
              { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0 },
              0.7
            ));
          }
        }
      }
    }
  }

  // ---- ROOMS (as SPACE elements) ----
  if (spec.rooms) {
    for (const room of spec.rooms) {
      const rLen = room.length_m || 5;
      const rWid = room.width_m || 4;
      const rHeight = room.height_m || floorToFloor;
      const rx = room.x_position_m || 0;
      const ry = room.y_position_m || 0;

      const placement = { origin: { x: rx, y: ry, z: floorLevel } };
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: rLen, height: rWid },
        direction: { x: 0, y: 0, z: 1 },
        depth: rHeight
      };

      addElement(makeElement('SPACE', 'IfcSpace', room.name || 'Room',
        placement, geometry, 'level-1',
        { usage: room.usage || 'OTHER' },
        { name: 'space', color: [0.8, 0.9, 1.0], transparency: 0.5 },
        0.7
      ));
    }
  }

  // ---- OPENINGS (DOOR / WINDOW) ----
  if (spec.openings) {
    const wallDims = { NORTH: { axis: 'x', base_y: width }, SOUTH: { axis: 'x', base_y: 0 }, EAST: { axis: 'y', base_x: length }, WEST: { axis: 'y', base_x: 0 } };

    for (const opening of spec.openings) {
      const isDoor = opening.type === 'DOOR';
      const oWidth = opening.width_m || (isDoor ? 0.9 : 1.2);
      const oHeight = opening.height_m || (isDoor ? 2.1 : 1.2);
      const sillHeight = opening.sill_height_m || (isDoor ? 0 : 0.9);
      const side = opening.wall_side || 'SOUTH';
      const offset = opening.x_offset_m || 1;
      const wallInfo = wallDims[side];

      let ox, oy;
      if (wallInfo.axis === 'x') {
        ox = offset;
        oy = wallInfo.base_y;
      } else {
        ox = wallInfo.base_x;
        oy = offset;
      }

      const placement = { origin: { x: ox, y: oy, z: floorLevel + sillHeight } };
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: oWidth, height: wallThickness },
        direction: { x: 0, y: 0, z: 1 },
        depth: oHeight
      };

      const type = isDoor ? 'DOOR' : 'WINDOW';
      const semanticType = isDoor ? 'IfcDoor' : 'IfcWindow';
      addElement(makeElement(type, semanticType, `${opening.type} - ${side}`,
        placement, geometry, 'level-1',
        { wallSide: side, sillHeight: sillHeight },
        { name: isDoor ? 'wood' : 'glass', color: isDoor ? [0.55, 0.35, 0.2] : [0.7, 0.85, 0.95], transparency: isDoor ? 0 : 0.3 },
        0.6
      ));
    }
  }

  // ---- EQUIPMENT ----
  if (spec.equipment) {
    for (const equip of spec.equipment) {
      const eLen = equip.length_m || 1.5;
      const eWid = equip.width_m || 1.0;
      const eHeight = equip.height_m || 1.5;
      const ex = equip.x_position_m || 0;
      const ey = equip.y_position_m || 0;

      const equipTypeMap = {
        'GENERATOR': 'IfcElectricGenerator', 'PUMP': 'IfcPump', 'FAN': 'IfcFan',
        'COMPRESSOR': 'IfcCompressor', 'TRANSFORMER': 'IfcTransformer', 'BOILER': 'IfcBoiler',
        'CHILLER': 'IfcChiller', 'AHU': 'IfcAirToAirHeatRecovery'
      };

      const placement = { origin: { x: ex, y: ey, z: floorLevel } };
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: eLen, height: eWid },
        direction: { x: 0, y: 0, z: 1 },
        depth: eHeight
      };

      addElement(makeElement('EQUIPMENT', equipTypeMap[equip.type] || 'IfcBuildingElementProxy',
        equip.name || equip.type || 'Equipment',
        placement, geometry, 'level-1',
        { equipmentType: equip.type || 'OTHER' },
        { name: 'steel', color: [0.5, 0.5, 0.55], transparency: 0 },
        0.65
      ));
    }
  }

  // Build bbox
  const totalHeight = floorLevel + (numFloors * floorToFloor) + 0.15;

  const css = {
    cssVersion: '1.0',
    domain,
    facility: {
      name: spec.buildingName || 'Structure',
      type: spec.buildingType?.toLowerCase() || 'building',
      description: '',
      units: 'M',
      crs: null,
      origin: { x: 0, y: 0, z: floorLevel },
      axes: 'RIGHT_HANDED_Z_UP'
    },
    levelsOrSegments: levels,
    elements,
    metadata: {
      sourceFiles: sourceFiles,
      outputMode: 'HYBRID',
      validationStatus: 'PENDING',
      unitNormalizationApplied: true,
      cssHash: null,
      elementCounts,
      bbox: {
        min: { x: 0, y: 0, z: floorLevel },
        max: { x: length, y: width, z: totalHeight }
      },
      repairLog: []
    }
  };

  return css;
}

// ============================================================================
// MINIMAL CSS FALLBACK (replaces standalone CreateMinimalCSS Lambda)
// ============================================================================

// ============================================================================
// ENRICHMENT — whitelist-only metadata patches from supplementary files
// ============================================================================

const ENRICHMENT_WHITELIST = new Set(['name', 'description', 'materials', 'psets']);
const ENRICHMENT_GEOMETRY_FIELDS = new Set([
  'placement', 'dimensions', 'width', 'height', 'depth', 'direction',
  'elevation', 'semantic_type', 'profile', 'length_m', 'depth_m',
  'width_m', 'height_m', 'geometry', 'position'
]);
const MAX_CHARS_PER_FILE = 50_000;
const MAX_TOTAL_SUPPLEMENTARY = 120_000;
const MULTI_PASS = process.env.MULTI_PASS !== 'false';

/**
 * Build supplementary text from non-primary files with round-robin truncation.
 */
function buildSupplementaryText(files) {
  const truncatedFiles = [];
  let sections = files.map(f => {
    const header = `=== File: ${f.name} (${f.contentType || 'text/plain'}) ===`;
    let content = f.content || '';
    const originalChars = content.length;

    if (content.length > MAX_CHARS_PER_FILE) {
      content = content.slice(0, MAX_CHARS_PER_FILE) + '\n...[truncated]';
      truncatedFiles.push({ name: f.name, originalChars, keptChars: MAX_CHARS_PER_FILE });
    }
    return { name: f.name, text: `${header}\n${content}`, length: header.length + 1 + content.length, originalChars };
  });

  // Check total and apply round-robin truncation if needed
  const totalLength = sections.reduce((sum, s) => sum + s.length, 0);
  if (totalLength > MAX_TOTAL_SUPPLEMENTARY) {
    const perFileAllowance = Math.floor(MAX_TOTAL_SUPPLEMENTARY / sections.length);
    sections = sections.map(s => {
      if (s.length > perFileAllowance) {
        const truncated = s.text.slice(0, perFileAllowance) + '\n...[truncated]';
        if (!truncatedFiles.find(t => t.name === s.name)) {
          truncatedFiles.push({ name: s.name, originalChars: s.originalChars, keptChars: perFileAllowance });
        }
        return { ...s, text: truncated };
      }
      return s;
    });
  }

  return {
    text: sections.map(s => s.text).join('\n\n'),
    truncatedFiles
  };
}

/**
 * Validate enrichment patch schema (v1.0).
 */
function validatePatchSchema(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.version !== '1.0') return false;
  const allowedKeys = new Set(['version', 'patches']);
  for (const key of Object.keys(response)) {
    if (!allowedKeys.has(key)) return false;
  }
  if (!Array.isArray(response.patches)) return false;
  for (const patch of response.patches) {
    if (typeof patch.element_key !== 'string') return false;
    if (!patch.updates || typeof patch.updates !== 'object') return false;
  }
  return true;
}

/**
 * Enrich CSS with metadata patches from supplementary files via Bedrock.
 * Only updates name, description, materials, psets. Never touches geometry.
 */
async function enrichCSS(cssData, supplementaryText, bedrockClient = bedrock) {
  // Collect all elements from both CSS structures:
  // - VentSim/DXF: top-level cssData.elements[]
  // - Bedrock: cssData.storeys[].elements[]
  const allElements = [];
  if (Array.isArray(cssData.elements)) {
    allElements.push(...cssData.elements);
  }
  for (const storey of (cssData.storeys || [])) {
    if (Array.isArray(storey.elements)) {
      allElements.push(...storey.elements);
    }
  }

  // Use element_key if available, otherwise fall back to id
  const elementKeys = allElements.map(el => el.element_key || el.id).filter(Boolean);

  if (elementKeys.length === 0) {
    console.log('No element_keys found in CSS — skipping enrichment');
    return cssData;
  }

  // Build a summary with keys AND names so Bedrock can match meaningfully
  const elementSummary = allElements.slice(0, 80).map(el => {
    const key = el.element_key || el.id;
    const name = el.name || '';
    const type = el.type || el.semanticType || '';
    return `  ${key} (name: "${name}", type: ${type})`;
  }).join('\n');

  const prompt = `You are enriching a building model with supplementary document data.
The model has ${elementKeys.length} elements:
${elementSummary}${elementKeys.length > 80 ? '\n  ... and more' : ''}

Supplementary documents:
${supplementaryText}

Return ONLY valid JSON matching this exact schema:
{
  "version": "1.0",
  "patches": [
    {
      "element_key": "<exact key from list above>",
      "updates": {
        "name": "optional new name",
        "description": "optional description",
        "materials": ["optional", "materials"],
        "psets": { "Pset_Name": { "Property": "Value" } }
      }
    }
  ]
}

Rules:
- Only use element_keys from the list above
- Only set name, description, materials, psets
- Do NOT include placement, dimensions, geometry, semantic_type, or any geometry fields
- Return empty patches array if no enrichment possible`;

  try {
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      })
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const text = responseBody.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('Enrichment: no JSON found in Bedrock response');
      return cssData;
    }

    const patchData = JSON.parse(jsonMatch[0]);

    // Validate schema
    if (!validatePatchSchema(patchData)) {
      console.warn('Enrichment: patch schema validation failed');
      return cssData;
    }

    // Build element lookup by key (supports both CSS structures)
    const elementMap = new Map();
    for (const el of allElements) {
      const key = el.element_key || el.id;
      if (key) elementMap.set(key, el);
    }

    // Apply patches with whitelist enforcement
    let appliedCount = 0;
    for (const patch of patchData.patches) {
      const element = elementMap.get(patch.element_key);
      if (!element) {
        console.warn(`Enrichment: unmatched element_key=${patch.element_key}`);
        continue;
      }

      for (const [field, value] of Object.entries(patch.updates)) {
        if (ENRICHMENT_GEOMETRY_FIELDS.has(field)) {
          console.warn(`REJECTED geometry edit for element_key=${patch.element_key} field=${field}`);
          continue;
        }
        if (!ENRICHMENT_WHITELIST.has(field)) {
          console.warn(`REJECTED unknown field for element_key=${patch.element_key} field=${field}`);
          continue;
        }
        element[field] = value;
      }
      appliedCount++;
    }

    console.log(`Enrichment: applied ${appliedCount}/${patchData.patches.length} patches`);

    // Update diagnostics
    if (cssData.metadata?.diagnostics) {
      cssData.metadata.diagnostics.enrichmentApplied = appliedCount > 0;
      cssData.metadata.diagnostics.enrichmentPatchCount = appliedCount;
    }

    return cssData;
  } catch (err) {
    console.warn('Enrichment failed:', err.message);
    return cssData;
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export const handler = async (event) => {
  console.log('ExtractBuildingSpec input:', JSON.stringify(event, null, 2));
  const { userId, renderId, bucket, files, description } = event;

  try {
    // Track per-file parse status
    const sourceFiles = [];

    // Download description if available
    let descriptionContent = description || '';
    const descFile = files.find(f => f.name === 'description.txt');
    if (descFile) {
      const result = await downloadFile(bucket, descFile.key);
      if (result.content) {
        descriptionContent = result.content;
        sourceFiles.push({ name: 'description.txt', parseStatus: 'success', role: 'description' });
      } else {
        sourceFiles.push({ name: 'description.txt', parseStatus: 'failed', role: 'description', reason: result.reason || 'empty' });
      }
    }

    // Download and process all files
    const processedFiles = [];

    for (const file of files) {
      if (file.name === 'description.txt') continue;

      const result = await downloadFile(bucket, file.key);

      if (result.type === 'text' && result.content) {
        processedFiles.push({ name: file.name, content: result.content });
        sourceFiles.push({ name: file.name, parseStatus: 'success', role: 'unknown' });
      } else if (result.type === 'unsupported') {
        sourceFiles.push({ name: file.name, parseStatus: 'unsupported', role: 'unknown', reason: result.reason });
      } else {
        sourceFiles.push({ name: file.name, parseStatus: 'failed', role: 'unknown', reason: result.reason || 'download error' });
      }
    }

    console.log(`Processed ${processedFiles.length} files, ${sourceFiles.filter(f => f.parseStatus !== 'success').length} failed/unsupported`);

    // Check for VentSim file
    const ventSimFile = processedFiles.find(f => isVentSim(f.content));
    if (ventSimFile) {
      console.log('Detected VentSim format in file:', ventSimFile.name);
      // Update source file role
      const sf = sourceFiles.find(f => f.name === ventSimFile.name);
      if (sf) sf.role = 'geometry';

      let css = parseVentSimToCSS(ventSimFile.content, ventSimFile.name);

      if (css) {
        css.metadata.sourceFiles = sourceFiles;

        // Enrichment: use supplementary files to add metadata to CSS elements
        const otherFiles = processedFiles.filter(f => f !== ventSimFile);
        if (otherFiles.length > 0) {
          const { text: suppText, truncatedFiles } = buildSupplementaryText(otherFiles);
          if (css.metadata?.diagnostics) css.metadata.diagnostics.truncatedFiles = truncatedFiles;
          css = await enrichCSS(css, suppText);
        }

        const ai_generated_title = css.facility.name;
        const ai_generated_description = css.facility.description;

        console.log('VentSim CSS extraction complete');
        const cssS3Key = await saveCSSToS3(bucket, userId, renderId, css);
        return { cssS3Key, ai_generated_title, ai_generated_description };
      }
    }

    // ---- DXF DETECTION ----
    const dxfFile = processedFiles.find(f => f.name.toLowerCase().endsWith('.dxf'));
    if (dxfFile) {
      console.log('Detected DXF format in file:', dxfFile.name);
      const sf = sourceFiles.find(f => f.name === dxfFile.name);
      if (sf) sf.role = 'geometry';

      let css = parseDxfToCSS(dxfFile.content);
      if (css) {
        css.metadata.sourceFiles = sourceFiles;

        // Enrichment: use supplementary files to add metadata to CSS elements
        const otherFiles = processedFiles.filter(f => f !== dxfFile);
        if (otherFiles.length > 0) {
          const { text: suppText, truncatedFiles } = buildSupplementaryText(otherFiles);
          if (css.metadata?.diagnostics) css.metadata.diagnostics.truncatedFiles = truncatedFiles;
          css = await enrichCSS(css, suppText);
        }

        const ai_generated_title = css.metadata.title || 'DXF Import';
        const ai_generated_description = `DXF model with ${css.metadata.diagnostics?.elementCount || 0} elements (${css.metadata.diagnostics?.proxyCount || 0} proxy, ${css.metadata.diagnostics?.semanticUpgradeCount || 0} semantic)`;

        console.log('DXF CSS extraction complete');
        const cssS3Key = await saveCSSToS3(bucket, userId, renderId, css);
        return { cssS3Key, ai_generated_title, ai_generated_description };
      }
    }

    // ---- BEDROCK EXTRACTION (single-pass or multi-pass) ----

    // Helper: call Bedrock with a prompt and return parsed JSON (or null)
    async function callBedrock(prompt, maxTokens = 4096) {
      const response = await bedrock.send(new InvokeModelCommand({
        modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }]
        })
      }));
      const body = JSON.parse(response.body instanceof Uint8Array ? new TextDecoder().decode(response.body) : response.body);
      const text = body.content?.[0]?.text || '';
      if (!text) return null;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    }

    // Helper: prepare file content for Bedrock prompts
    function prepareFileContent(files) {
      const MAX_FILE_CHARS = 50000;
      const MAX_TOTAL_CHARS = 150000;
      const RELEVANT_KEYWORDS = /ventilation|hvac|system|fan|duct|equipment|air|flow|pressure|shaft|dimension|floor|wall|room|column|beam|slab|foundation|elevation|height|width|length|material|concrete|steel/i;
      let totalChars = 0;
      const parts = [];

      for (const file of files) {
        if (totalChars >= MAX_TOTAL_CHARS) break;
        let content = file.content;
        if (content.length > 30000) {
          const paragraphs = content.split(/\n\s*\n/);
          const relevant = paragraphs.filter(p => RELEVANT_KEYWORDS.test(p));
          content = relevant.length > 0 ? relevant.join('\n\n') : content.substring(0, 30000);
        }
        if (content.length > MAX_FILE_CHARS) content = content.substring(0, MAX_FILE_CHARS) + '\n[... truncated ...]';
        totalChars += content.length;
        parts.push(`File: ${file.name}\n\n${content}`);
      }
      return parts.join('\n\n---\n\n');
    }

    // Single-pass extraction (existing behavior)
    async function singlePassExtraction() {
      console.log('Running single-pass Bedrock extraction...');
      const fileContent = prepareFileContent(processedFiles);

      const prompt = `You are an expert in interpreting architectural and engineering documents to extract building specifications.
Extract structured data from the provided files and return it as a JSON object. ALL DIMENSIONS IN METRES.

Return ONLY valid JSON (no markdown, no explanations):

{
  "buildingName": "string",
  "buildingType": "BUILDING | OFFICE | WAREHOUSE | TUNNEL | FACILITY | PARKING | HOSPITAL | SCHOOL | INDUSTRIAL | RESIDENTIAL",
  "dimensions": {
    "length_m": number,
    "width_m": number,
    "height_m": number,
    "wall_thickness_m": number (default 0.3)
  },
  "elevations": { "floor_level_m": number (default 0.0) },
  "rooms": [{ "name": "string", "usage": "OFFICE|STORAGE|MECHANICAL|ELECTRICAL|CIRCULATION|WC|LOBBY|LAB|PARKING|OTHER", "length_m": number, "width_m": number, "height_m": number, "x_position_m": number, "y_position_m": number }],
  "openings": [{ "type": "DOOR|WINDOW", "wall_side": "NORTH|SOUTH|EAST|WEST", "x_offset_m": number, "width_m": number, "height_m": number, "sill_height_m": number }],
  "ventilation": { "system_type": "natural|mechanical|hybrid", "intake_location": "string", "exhaust_location": "string", "num_fans": number },
  "equipment": [{ "name": "string", "type": "GENERATOR|PUMP|FAN|COMPRESSOR|TRANSFORMER|BATTERY|CONVERTER|BOILER|CHILLER|AHU|OTHER", "x_position_m": number, "y_position_m": number, "length_m": number, "width_m": number, "height_m": number }],
  "materials": { "walls": "concrete|brick|steel|timber|glass|other", "floor": "concrete|timber|raised_access|screed|other", "roof": "concrete|metal|membrane|tiles|other" },
  "structural_system": "FRAME|LOADBEARING|SHELL|TRUSS|OTHER",
  "structure": { "column_grid": [{ "x_spacing_m": number, "y_spacing_m": number, "column_size_m": number }], "floor_to_floor_height_m": number, "num_floors": number },
  "interior_walls": [{ "name": "string", "x_start_m": number, "y_start_m": number, "x_end_m": number, "y_end_m": number, "height_m": number, "thickness_m": number }]
}

Convert feet/inches to metres. Use realistic defaults for missing values. Return empty arrays [] when no data.

Building Description:
${descriptionContent || '(No description provided)'}

${sourceFiles.filter(f => f.parseStatus === 'unsupported').length > 0 ? `\nNote: These file types were uploaded but could not be parsed: ${sourceFiles.filter(f => f.parseStatus === 'unsupported').map(f => f.name).join(', ')}` : ''}

${fileContent}`;

      return await callBedrock(prompt);
    }

    // Multi-pass extraction
    async function multiPassExtraction() {
      console.log('Running multi-pass Bedrock extraction...');

      // Pass 1 — Classify (advisory, skip if fails)
      let classification = null;
      try {
        const snippets = processedFiles.map(f => `File: ${f.name}\n${f.content.slice(0, 2000)}`).join('\n---\n');
        const pass1Prompt = `Classify these building/engineering documents. Return ONLY valid JSON:
{
  "buildingType": "BUILDING|OFFICE|WAREHOUSE|TUNNEL|FACILITY|PARKING|HOSPITAL|SCHOOL|INDUSTRIAL|RESIDENTIAL",
  "domainHints": ["architecture", "structural", "mechanical", "electrical", etc.],
  "fileRoles": { "filename.txt": "floor_plan|specifications|schedule|description|other" }
}

Documents:
${snippets}`;

        const pass1Result = await callBedrock(pass1Prompt, 2048);
        if (pass1Result && pass1Result.buildingType && typeof pass1Result.buildingType === 'string') {
          classification = pass1Result;
          console.log(`Pass 1 classification: ${classification.buildingType}, hints: ${classification.domainHints?.join(', ')}`);
        } else {
          console.warn('Pass 1: classification schema invalid, using generic prompts');
        }
      } catch (err) {
        console.warn('Pass 1 failed, using generic prompts:', err.message);
      }

      // Pass 2 — Geometry (main extraction, fallback to single-pass if invalid)
      const domainContext = classification
        ? `This is a ${classification.buildingType} project with domain hints: ${classification.domainHints?.join(', ')}.`
        : 'Extract building geometry from the provided documents.';

      const fileContent = prepareFileContent(processedFiles);
      const pass2Prompt = `${domainContext}
You are an expert in interpreting architectural and engineering documents to extract building specifications.
Extract structured data and return it as a JSON object. ALL DIMENSIONS IN METRES.

Return ONLY valid JSON (no markdown, no explanations):

{
  "buildingName": "string",
  "buildingType": "BUILDING | OFFICE | WAREHOUSE | TUNNEL | FACILITY | PARKING | HOSPITAL | SCHOOL | INDUSTRIAL | RESIDENTIAL",
  "dimensions": { "length_m": number, "width_m": number, "height_m": number, "wall_thickness_m": number },
  "elevations": { "floor_level_m": number },
  "rooms": [{ "name": "string", "usage": "string", "length_m": number, "width_m": number, "height_m": number, "x_position_m": number, "y_position_m": number }],
  "openings": [{ "type": "DOOR|WINDOW", "wall_side": "NORTH|SOUTH|EAST|WEST", "x_offset_m": number, "width_m": number, "height_m": number, "sill_height_m": number }],
  "ventilation": { "system_type": "string", "num_fans": number },
  "equipment": [{ "name": "string", "type": "string", "x_position_m": number, "y_position_m": number, "length_m": number, "width_m": number, "height_m": number }],
  "materials": { "walls": "string", "floor": "string", "roof": "string" },
  "structural_system": "FRAME|LOADBEARING|SHELL|TRUSS|OTHER",
  "structure": { "column_grid": [], "floor_to_floor_height_m": number, "num_floors": number },
  "interior_walls": [{ "name": "string", "x_start_m": number, "y_start_m": number, "x_end_m": number, "y_end_m": number, "height_m": number, "thickness_m": number }]
}

Convert feet/inches to metres. Use realistic defaults for missing values. Return empty arrays [] when no data.

Building Description:
${descriptionContent || '(No description provided)'}

${fileContent}`;

      let buildingSpec;
      try {
        buildingSpec = await callBedrock(pass2Prompt);
        if (!buildingSpec || !buildingSpec.dimensions) {
          console.warn('Pass 2: geometry schema invalid, falling back to single-pass');
          return await singlePassExtraction();
        }
        console.log(`Pass 2 geometry extracted: ${buildingSpec.buildingName || 'unnamed'}`);
      } catch (err) {
        console.warn('Pass 2 failed, falling back to single-pass:', err.message);
        return await singlePassExtraction();
      }

      // Pass 3 — Semantics (enrichment patches, skip if fails)
      // Convert buildingSpec to CSS first so we have element_keys
      applyBuildingSpecDefaults(buildingSpec);
      let css = buildingSpecToCSS(buildingSpec, sourceFiles);

      try {
        const elementSummary = (css.storeys || []).flatMap(s => (s.elements || []).map(e => e.element_key)).filter(Boolean).slice(0, 50);
        const pass3Prompt = `You are enriching a building model with additional metadata.
The model has these element keys: ${elementSummary.join(', ')}

Source documents:
${fileContent.slice(0, 50000)}

Return ONLY valid JSON:
{
  "version": "1.0",
  "patches": [
    {
      "element_key": "<exact key from above>",
      "updates": {
        "name": "optional display name",
        "description": "optional description",
        "materials": ["optional", "materials"],
        "psets": { "Pset_Name": { "Property": "Value" } }
      }
    }
  ]
}

Rules: Only use element_keys from the list. Only set name, description, materials, psets. No geometry fields.`;

        const pass3Result = await callBedrock(pass3Prompt, 4096);
        if (pass3Result && validatePatchSchema(pass3Result)) {
          // Apply patches via whitelist
          const elementMap = new Map();
          for (const storey of (css.storeys || [])) {
            for (const el of (storey.elements || [])) {
              if (el.element_key) elementMap.set(el.element_key, el);
            }
          }
          let patchCount = 0;
          for (const patch of pass3Result.patches) {
            const element = elementMap.get(patch.element_key);
            if (!element) continue;
            for (const [field, value] of Object.entries(patch.updates)) {
              if (ENRICHMENT_GEOMETRY_FIELDS.has(field)) {
                console.warn(`Pass 3: REJECTED geometry edit for element_key=${patch.element_key} field=${field}`);
                continue;
              }
              if (ENRICHMENT_WHITELIST.has(field)) element[field] = value;
            }
            patchCount++;
          }
          console.log(`Pass 3: applied ${patchCount} semantic patches`);
        } else {
          console.warn('Pass 3: patch schema invalid, returning Pass 2 CSS as-is');
        }
      } catch (err) {
        console.warn('Pass 3 failed, returning Pass 2 CSS:', err.message);
      }

      return { buildingSpec, enrichedCSS: css };
    }

    // Apply defaults to building spec
    function applyBuildingSpecDefaults(spec) {
      if (!spec.buildingName) spec.buildingName = 'Structure';
      if (!spec.buildingType) spec.buildingType = 'BUILDING';
      if (!spec.dimensions) spec.dimensions = { length_m: 20, width_m: 10, height_m: 3, wall_thickness_m: 0.3 };
      if (spec.dimensions.wall_thickness_m === undefined) spec.dimensions.wall_thickness_m = 0.3;
      if (!spec.elevations) spec.elevations = {};
      if (spec.elevations.floor_level_m === undefined) spec.elevations.floor_level_m = 0.0;
      if (!spec.rooms) spec.rooms = [];
      if (!spec.openings) spec.openings = [];
      if (!spec.ventilation) spec.ventilation = { system_type: 'natural', num_fans: 0 };
      if (!spec.equipment) spec.equipment = [];
      if (!spec.materials) spec.materials = { walls: 'concrete', floor: 'concrete', roof: 'metal' };
      if (!spec.structural_system) spec.structural_system = 'LOADBEARING';
    }

    // Run extraction
    let buildingSpec;
    let enrichedCSS = null;
    try {
      if (MULTI_PASS) {
        const result = await multiPassExtraction();
        buildingSpec = result.buildingSpec;
        enrichedCSS = result.enrichedCSS;
      } else {
        buildingSpec = await singlePassExtraction();
      }
    } catch (err) {
      console.error('Bedrock extraction failed:', err.message, err.stack);
      console.error('Bedrock extraction error details:', JSON.stringify({ name: err.name, code: err.$metadata?.httpStatusCode, requestId: err.$metadata?.requestId }));
      throw new Error(`Bedrock extraction failed: ${err.message}`);
    }

    if (!buildingSpec) {
      console.error('Bedrock returned empty/unparseable response');
      throw new Error('Bedrock returned empty or unparseable response');
    }

    // Use enriched CSS from multi-pass if available, otherwise convert from spec
    let css;
    if (enrichedCSS) {
      css = enrichedCSS;
    } else {
      applyBuildingSpecDefaults(buildingSpec);
      css = buildingSpecToCSS(buildingSpec, sourceFiles);
    }

    // Generate AI title and description
    const ai_generated_title = buildingSpec.buildingName || 'Structure Model';
    const descParts = [];
    descParts.push(`${buildingSpec.buildingType} project: ${buildingSpec.dimensions.length_m}m x ${buildingSpec.dimensions.width_m}m x ${buildingSpec.dimensions.height_m}m.`);
    if (buildingSpec.rooms?.length > 0) {
      descParts.push(`${buildingSpec.rooms.length} room(s) including ${buildingSpec.rooms.slice(0, 3).map(r => r.name).join(', ')}${buildingSpec.rooms.length > 3 ? ' and more.' : '.'}`);
    }
    if (buildingSpec.equipment?.length > 0) {
      descParts.push(`${buildingSpec.equipment.length} equipment item(s).`);
    }
    const ai_generated_description = descParts.join(' ');

    css.facility.description = ai_generated_description;

    console.log(`CSS generated: ${css.elements?.length || 0} elements, domain=${css.domain}`);

    const cssS3Key = await saveCSSToS3(bucket, userId, renderId, css);
    return { cssS3Key, ai_generated_title, ai_generated_description };
  } catch (error) {
    console.error('ExtractBuildingSpec error:', error);
    // Let the error propagate to the Step Function so HandleFailure can mark it as failed
    throw error;
  }
};
