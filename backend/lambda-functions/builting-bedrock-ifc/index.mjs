import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import pdf from 'pdf-parse';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const s3 = new S3Client({ region: 'us-east-1' });

// Download file from S3 and return as buffer/string
async function downloadFile(bucket, key) {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );

    const ext = key.toLowerCase().split('.').pop();
    if (ext === 'txt') {
      // Text files - convert to string
      return {
        content: await response.Body.transformToString(),
        type: 'text'
      };
    } else if (ext === 'pdf') {
      // PDF files - extract text
      try {
        const buffer = await response.Body.transformToByteArray();
        const data = await pdf(Buffer.from(buffer));
        return {
          content: data.text,
          type: 'text'
        };
      } catch (err) {
        console.warn(`Failed to extract text from PDF ${key}:`, err.message);
        return {
          content: null,
          type: 'unsupported'
        };
      }
    } else {
      // Other binary formats (DWG, XLSX, DOCX) are unsupported
      return {
        content: null,
        type: 'unsupported'
      };
    }
  } catch (err) {
    console.warn(`Failed to download ${key}:`, err.message);
    return {
      content: null,
      type: 'error'
    };
  }
}

// ============================================================================
// VENTSIM PARSER - Extract tunnel network data from VentSim export files
// ============================================================================

function isVentSim(content) {
  /**Detect if content is a VentSim file by checking for VentSim-specific markers*/
  return content.includes('KFACTORS') && content.includes('MAIN') && content.includes('6.0.4');
}

function parseVentSim(content) {
  /**Parse VentSim MAIN section and extract tunnel branch data*/
  console.log('Parsing VentSim format...');

  try {
    const lines = content.split('\n');

    // Find MAIN section
    let mainStartIdx = -1;
    let mainEndIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('MAIN')) {
        mainStartIdx = i;
      }
      if (mainStartIdx !== -1 && (line.startsWith('END\tMAIN') || line === 'END MAIN')) {
        mainEndIdx = i;
        break;
      }
    }

    if (mainStartIdx === -1 || mainEndIdx === -1) {
      console.warn('MAIN section not found in VentSim file');
      return null;
    }

    console.log(`MAIN section: lines ${mainStartIdx} to ${mainEndIdx}`);

    // Parse header (line after MAIN)
    const headerLine = lines[mainStartIdx + 1];
    const headers = headerLine.split('\t');
    const colIndex = {};
    headers.forEach((header, idx) => {
      colIndex[header.trim()] = idx;
    });

    console.log(`Found ${headers.length} columns in MAIN section`);

    // Extract tunnel branches
    const branches = [];
    const fanMap = {};
    let minZ = Infinity, maxZ = -Infinity;

    for (let i = mainStartIdx + 2; i < mainEndIdx; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split('\t');
      const branch = {
        unique_no: parseInt(cols[colIndex['Unique No']] || cols[0]) || 0,
        name: cols[colIndex['Branch Name']] || `Branch_${i}`,
        entry_node: cols[colIndex['Entry Node']] || '',
        exit_node: cols[colIndex['Exit Node']] || '',
        group: parseInt(cols[colIndex['Group']] || cols[8]) || 0,
        x1: parseFloat(cols[colIndex['X1']] || cols[9]) || 0,
        y1: parseFloat(cols[colIndex['Y1']] || cols[10]) || 0,
        z1: parseFloat(cols[colIndex['Z1']] || cols[11]) || 0,
        x2: parseFloat(cols[colIndex['X2']] || cols[12]) || 0,
        y2: parseFloat(cols[colIndex['Y2']] || cols[13]) || 0,
        z2: parseFloat(cols[colIndex['Z2']] || cols[14]) || 0,
        width: parseFloat(cols[colIndex['Width']] || cols[15]) || 1.0,
        height: parseFloat(cols[colIndex['Height']] || cols[16]) || 1.0,
        area: parseFloat(cols[colIndex['Area']] || cols[17]) || 1.0,
        shape_type: parseInt(cols[colIndex['Shape Type']] || cols[18]) || 0, // 0=rect, 1=round
        fan_type: parseInt(cols[colIndex['Fan Type']] || cols[29]) || 0,
        fan_numbers: parseInt(cols[colIndex['Fan Numbers']] || cols[30]) || 0,
        liner_type: parseInt(cols[colIndex['Liner Type']] || cols[35]) || 1 // default concrete
      };

      // Track Z bounds for normalization
      minZ = Math.min(minZ, branch.z1, branch.z2);
      maxZ = Math.max(maxZ, branch.z1, branch.z2);

      branches.push(branch);
    }

    console.log(`Extracted ${branches.length} tunnel branches`);

    // Parse FANS section
    const fans = [];
    const fansStartIdx = lines.findIndex(l => l.trim().startsWith('FANS'));
    if (fansStartIdx !== -1) {
      const fansEndIdx = lines.findIndex((l, i) => i > fansStartIdx && (l.trim().startsWith('END\tFANS') || l.trim() === 'END FANS'));

      for (let i = fansStartIdx + 1; i < fansEndIdx; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('END')) break;

        const cols = line.split('\t');
        if (cols.length > 2) {
          const fan = {
            fan_id: parseInt(cols[0]) || 0,
            name: cols[1] || `Fan_${cols[0]}`,
            diameter: parseFloat(cols[2]) || 1.0
          };
          fans.push(fan);
          fanMap[fan.fan_id] = fan;
        }
      }
    }

    console.log(`Extracted ${fans.length} fans`);

    // Identify named spaces (branches with names)
    const namedSpaces = {};
    branches.forEach(b => {
      if (b.name && b.name !== '' && !b.name.startsWith('Branch_')) {
        if (!namedSpaces[b.name]) {
          namedSpaces[b.name] = [];
        }
        namedSpaces[b.name].push(b);
      }
    });

    // Build coordinate bounding box
    const xValues = branches.flatMap(b => [b.x1, b.x2]);
    const yValues = branches.flatMap(b => [b.y1, b.y2]);

    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);

    const dimLength = maxX - minX || 100;
    const dimWidth = maxY - minY || 50;
    const dimHeight = maxZ - minZ || 10;

    console.log(`Bounding box: X[${minX}-${maxX}] Y[${minY}-${maxY}] Z[${minZ}-${maxZ}]`);
    console.log(`Dimensions: ${dimLength}m x ${dimWidth}m x ${dimHeight}m`);

    // Build buildingSpec
    const buildingSpec = {
      buildingName: 'Tunnel Network',
      buildingType: 'TUNNEL',
      dimensions: {
        length_m: dimLength,
        width_m: dimWidth,
        height_m: dimHeight,
        wall_thickness_m: 0.3
      },
      elevations: {
        floor_level_m: 0.0
      },
      tunnel_branches: branches.map(b => ({
        ...b,
        z1: b.z1 - minZ,
        z2: b.z2 - minZ
      })),
      tunnel_bounds: {
        min_x: minX,
        min_y: minY,
        min_z: minZ,
        max_x: maxX,
        max_y: maxY,
        max_z: maxZ
      },
      fans: fans.map(f => ({
        ...f,
        x_position_m: 0,
        y_position_m: 0,
        z_position_m: 0
      })),
      ventilation: {
        system_type: 'mechanical',
        intake_location: 'West',
        exhaust_location: 'East',
        num_fans: fans.length
      },
      rooms: Object.keys(namedSpaces).map((spaceName, idx) => ({
        name: spaceName,
        usage: 'OTHER',
        length_m: 10,
        width_m: 5,
        height_m: 5,
        x_position_m: minX + (idx * 15),
        y_position_m: minY + 5
      })),
      equipment: fans.map((fan, idx) => ({
        name: fan.name,
        type: 'FAN',
        x_position_m: minX + (idx * 20),
        y_position_m: minY + 10,
        length_m: fan.diameter,
        width_m: fan.diameter,
        height_m: fan.diameter
      })),
      materials: {
        walls: 'concrete',
        floor: 'concrete',
        roof: 'metal'
      }
    };

    return {
      buildingSpec,
      isVentSim: true
    };
  } catch (err) {
    console.error('Error parsing VentSim:', err.message);
    return null;
  }
}

export const handler = async (event) => {
  console.log('BedrockInvokeIFC input:', event);
  const { renderId, bucket, files, description } = event;

  try {
    // Download description if available
    let descriptionContent = description || '';
    const descFile = files.find(f => f.name === 'description.txt');
    if (descFile) {
      const result = await downloadFile(bucket, descFile.key);
      if (result.content) {
        descriptionContent = result.content;
      }
    }

    // Download and process all files
    const processedFiles = [];
    const unsupportedFiles = [];

    for (const file of files) {
      if (file.name === 'description.txt') continue; // Already handled

      const result = await downloadFile(bucket, file.key);

      if (result.type === 'text') {
        processedFiles.push({
          name: file.name,
          content: result.content
        });
      } else {
        unsupportedFiles.push(file.name);
      }
    }

    console.log(`Processed ${processedFiles.length} files, ${unsupportedFiles.length} unsupported`);

    // Check if this is a VentSim file
    const ventSimFile = processedFiles.find(f => isVentSim(f.content));
    if (ventSimFile) {
      console.log('Detected VentSim format in file:', ventSimFile.name);
      const ventSimResult = parseVentSim(ventSimFile.content);

      if (ventSimResult) {
        const { buildingSpec } = ventSimResult;

        // Generate title and description from VentSim data
        const ai_generated_title = buildingSpec.buildingName || 'Tunnel Network Model';
        const tunnelBranchCount = buildingSpec.tunnel_branches?.length || 0;
        const fanCount = buildingSpec.fans?.length || 0;
        const ai_generated_description = `Tunnel ventilation network with ${tunnelBranchCount} branches, ${fanCount} fans, and ${Object.keys(buildingSpec.rooms || {}).length} named spaces. Network spans ${buildingSpec.dimensions.length_m.toFixed(1)}m x ${buildingSpec.dimensions.width_m.toFixed(1)}m with ${buildingSpec.dimensions.height_m.toFixed(1)}m elevation variation.`;

        console.log('VentSim extraction complete');
        return {
          ...event,
          buildingSpec,
          ai_generated_title,
          ai_generated_description
        };
      }
    }

    // If not VentSim, proceed with Bedrock extraction
    // Build Claude message content with files
    const messageContent = [
      {
        type: 'text',
        text: `You are an expert in interpreting architectural and engineering documents to extract comprehensive building specifications.
Extract structured data from the provided files and return it as a JSON object. This JSON will be converted to a 3D IFC model by another system.

═══════════════════════════════════════════════════════════════
REQUIRED JSON STRUCTURE:
═══════════════════════════════════════════════════════════════
Return ONLY valid JSON (no markdown, no explanations). All REQUIRED fields must be present.

{
  "buildingName": "string - descriptive name for the building/structure",
  "buildingType": "string - one of: BUILDING, OFFICE, WAREHOUSE, TUNNEL, FACILITY, PARKING, HOSPITAL, SCHOOL, INDUSTRIAL, RESIDENTIAL",
  "dimensions": {
    "length_m": number - main length dimension in metres,
    "width_m": number - width dimension in metres,
    "height_m": number - height/depth dimension in metres,
    "wall_thickness_m": number - exterior wall thickness (default 0.3 if not specified)
  },
  "elevations": {
    "floor_level_m": number - ground level elevation (default 0.0)
  },
  "rooms": [
    {
      "name": "string - room name/identifier",
      "usage": "string - one of: OFFICE, STORAGE, MECHANICAL, ELECTRICAL, CIRCULATION, WC, LOBBY, LAB, PARKING, OTHER",
      "length_m": number,
      "width_m": number,
      "height_m": number,
      "x_position_m": number - X offset from origin,
      "y_position_m": number - Y offset from origin
    }
  ],
  "openings": [
    {
      "type": "string - DOOR or WINDOW",
      "wall_side": "string - NORTH, SOUTH, EAST, or WEST",
      "x_offset_m": number - position along the wall,
      "width_m": number - opening width,
      "height_m": number - opening height,
      "sill_height_m": number - height from floor to opening sill (0.0 for doors, 0.9 for windows typically)
    }
  ],
  "ventilation": {
    "system_type": "string - 'natural', 'mechanical', or 'hybrid'",
    "intake_location": "string - e.g. 'West', 'North'",
    "exhaust_location": "string - e.g. 'East', 'South'",
    "num_fans": number - number of fans/terminals (default 1)
  },
  "equipment": [
    {
      "name": "string - equipment identifier",
      "type": "string - GENERATOR, PUMP, FAN, COMPRESSOR, TRANSFORMER, BATTERY, CONVERTER, BOILER, CHILLER, AHU, or OTHER",
      "x_position_m": number - X position,
      "y_position_m": number - Y position,
      "length_m": number (optional) - equipment length, or null for default size,
      "width_m": number (optional) - equipment width, or null for default size,
      "height_m": number (optional) - equipment height, or null for default size
    }
  ],
  "materials": {
    "walls": "string - material type (concrete, brick, steel, timber, glass, other) - default: concrete",
    "wall_finish": "string - interior finish (plasterboard, paint, tiles, panels, other) - default: plasterboard",
    "wall_insulation": "string - insulation type if any (mineral_wool, foam, other) - default: null",
    "floor": "string - material type (concrete, timber, raised_access, screed, other) - default: concrete",
    "roof": "string - material type (concrete, metal, membrane, tiles, other) - default: metal"
  },
  "structural_system": "string - FRAME, LOADBEARING, SHELL, TRUSS, or OTHER - default: LOADBEARING",
  "structure": {
    "column_grid": [
      {
        "x_spacing_m": number - spacing between columns in X direction,
        "y_spacing_m": number - spacing between columns in Y direction,
        "column_size_m": number - column width/diameter (0.3-0.5m typical)
      }
    ],
    "floor_to_floor_height_m": number - typical floor-to-floor height,
    "num_floors": number - number of stories/levels (default 1)
  },
  "interior_walls": [
    {
      "name": "string - wall identifier",
      "x_start_m": number - X coordinate of wall start,
      "y_start_m": number - Y coordinate of wall start,
      "x_end_m": number - X coordinate of wall end,
      "y_end_m": number - Y coordinate of wall end,
      "height_m": number - wall height,
      "thickness_m": number - wall thickness (0.1-0.2m typical)
    }
  ]
}

═══════════════════════════════════════════════════════════════
EXTRACTION GUIDELINES:
═══════════════════════════════════════════════════════════════
CRITICAL:
- ALL DIMENSIONS AND ELEVATIONS MUST BE IN METRES
- Convert imperial (feet/inches) to metres: 1 foot = 0.3048m, 1 inch = 0.0254m
- Return empty arrays [] for sections with no information in documents
- For missing optional fields, use null or omit them
- buildingType: Infer from content. TUNNEL = tunnel/subway/culvert, WAREHOUSE = warehouse/storage facility, PARKING = parking garage/lot, etc.

DETAILED FIELD GUIDANCE:
1. buildingName: Project title, structure name, or descriptive identifier from documents
2. buildingType: Infer from building purpose (tunnel, warehouse, office building, industrial facility, hospital, school, residential complex, parking garage)
3. dimensions.length_m/width_m/height_m: Main structural dimensions; for tunnels, length = tunnel length, height = tunnel diameter
4. dimensions.wall_thickness_m: Typical exterior wall thickness in metres (0.2-0.5m for standard construction)
5. rooms: Extract rooms/spaces from floor plans or descriptions with usage classification (OFFICE, MECHANICAL, etc.)
6. openings: Extract doors/windows with wall side and positions; estimate typical door height (2.1m), window sill (0.9m)
7. ventilation: Look for HVAC, ventilation, fan, air system, duct, intake, exhaust mentions. Count number of fans if available.
8. equipment: Extract generators, pumps, transformers, compressors, fans, batteries, converters, boilers, chillers, AHUs with spatial positions
9. materials: Identify structural/finish materials AND finishes/coatings from construction documents. Include wall insulation if mentioned.
10. structural_system: Infer from building type (office/warehouse typically frame, tunnels typically shell/lining)
11. structure.column_grid: If building type is FRAME, extract or infer column spacing. Typical office: 6-9m spacing. Warehouse: 8-12m spacing.
12. structure.floor_to_floor_height_m: Typical building: 3.5-4.0m, warehouse: 6-8m, parking: 2.5-3.0m
13. structure.num_floors: Count stories if multi-story building mentioned
14. interior_walls: Extract partition wall locations from floor plans. Include walls separating different room types. Provide start/end coordinates and thickness.

SPECIAL CASES:
- TUNNEL: length_m = tunnel length, width_m ≈ height_m ≈ tunnel diameter, wall_thickness_m = lining thickness
- WAREHOUSE: Often large open spans, minimal interior walls; indicate via room usage = STORAGE
- PARKING: May have ramps; indicate via openings with wall_side positioning
- INDUSTRIAL: Often has heavy equipment; add equipment entries with realistic positioning

═══════════════════════════════════════════════════════════════

Building Description:
${descriptionContent || '(No description provided)'}

${unsupportedFiles.length > 0 ? `\nAdditional files provided (type: ${unsupportedFiles.join(', ')}): Extract any dimensions, equipment, or layout information if visible` : ''}

═══════════════════════════════════════════════════════════════
YOUR TASK:
═══════════════════════════════════════════════════════════════
Extract comprehensive building specification from the above information and return ONLY the JSON object.
NO markdown, NO explanations, NO extra text - just the valid JSON conforming to the schema above.
Use realistic defaults for any missing but inferable information (e.g., standard wall thickness = 0.3m, standard door height = 2.1m).`
      }
    ];

    // Smart section extraction - keep relevant content only
    const RELEVANT_KEYWORDS = /ventilation|hvac|system|fan|duct|equipment|air|flow|pressure|ventsim|shaft|diesel|ac|equipment|mapping/i;
    const MAX_FILE_CHARS = 50000; // Per file limit
    const MAX_TOTAL_CHARS = 150000; // Total limit
    let totalChars = 0;

    for (const file of processedFiles) {
      if (totalChars >= MAX_TOTAL_CHARS) {
        console.log(`Stopping file inclusion - reached ${MAX_TOTAL_CHARS} character limit`);
        break;
      }

      let content = file.content;

      // For large files, extract relevant sections only
      if (content.length > 30000) {
        console.log(`Extracting relevant sections from ${file.name} (${content.length} chars)`);

        // Split by paragraphs (double newlines)
        const paragraphs = content.split(/\n\s*\n/);
        const relevantSections = paragraphs.filter(p => RELEVANT_KEYWORDS.test(p));

        if (relevantSections.length > 0) {
          content = relevantSections.join('\n\n');
          console.log(`Extracted ${relevantSections.length} relevant sections (${content.length} chars)`);
        } else {
          // If no relevant sections, use beginning of file
          console.log(`No relevant sections found, using first 30000 chars`);
          content = content.substring(0, 30000);
        }
      }

      // Final size limit
      if (content.length > MAX_FILE_CHARS) {
        console.log(`Truncating ${file.name} to ${MAX_FILE_CHARS} chars`);
        content = content.substring(0, MAX_FILE_CHARS) + '\n[... truncated ...]';
      }

      totalChars += content.length;
      messageContent.push({
        type: 'text',
        text: `File: ${file.name}\n\n${content}`
      });
    }

    console.log('Calling Bedrock Claude 3 Sonnet...');

    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: messageContent
            }
          ]
        })
      })
    );

    const responseBody = JSON.parse(
      response.body instanceof Uint8Array
        ? new TextDecoder().decode(response.body)
        : response.body
    );

    console.log('Bedrock response received');

    // Extract buildingSpec JSON from response
    let responseText = '';
    if (responseBody.content && responseBody.content.length > 0) {
      responseText = responseBody.content[0].text || '';
    }

    if (!responseText) {
      throw new Error('Bedrock returned empty response');
    }

    // Parse JSON response
    let buildingSpec;
    try {
      // Clean markdown code fences if present (```json ... ```)
      let cleanText = responseText.trim();
      const fenceMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) {
        cleanText = fenceMatch[1];
        console.log('Stripped markdown code fences from JSON response');
      }
      buildingSpec = JSON.parse(cleanText);
    } catch (err) {
      console.error('Failed to parse Bedrock JSON response:', err);
      console.error('Response text:', responseText.substring(0, 500));
      throw new Error(`Invalid JSON from Bedrock: ${err.message}`);
    }

    // Validate required fields and apply defaults
    if (!buildingSpec.buildingName) {
      buildingSpec.buildingName = 'Structure';
    }
    if (!buildingSpec.buildingType) {
      buildingSpec.buildingType = 'BUILDING';
    }
    if (!buildingSpec.dimensions) {
      buildingSpec.dimensions = { length_m: 100, width_m: 50, height_m: 6, wall_thickness_m: 0.3 };
    } else {
      if (buildingSpec.dimensions.wall_thickness_m === undefined) {
        buildingSpec.dimensions.wall_thickness_m = 0.3;
      }
    }
    if (!buildingSpec.elevations) {
      buildingSpec.elevations = {};
    }
    if (buildingSpec.elevations.floor_level_m === undefined) {
      buildingSpec.elevations.floor_level_m = 0.0;
    }
    if (!buildingSpec.rooms) {
      buildingSpec.rooms = [];
    }
    if (!buildingSpec.openings) {
      buildingSpec.openings = [];
    }
    if (!buildingSpec.ventilation) {
      buildingSpec.ventilation = { system_type: 'natural', intake_location: 'West', exhaust_location: 'East', num_fans: 1 };
    } else {
      if (!buildingSpec.ventilation.system_type) buildingSpec.ventilation.system_type = 'natural';
      if (!buildingSpec.ventilation.intake_location) buildingSpec.ventilation.intake_location = 'West';
      if (!buildingSpec.ventilation.exhaust_location) buildingSpec.ventilation.exhaust_location = 'East';
      if (buildingSpec.ventilation.num_fans === undefined) buildingSpec.ventilation.num_fans = 1;
    }
    if (!buildingSpec.equipment) {
      buildingSpec.equipment = [];
    }
    if (!buildingSpec.materials) {
      buildingSpec.materials = { walls: 'concrete', floor: 'concrete', roof: 'metal' };
    } else {
      if (!buildingSpec.materials.walls) buildingSpec.materials.walls = 'concrete';
      if (!buildingSpec.materials.floor) buildingSpec.materials.floor = 'concrete';
      if (!buildingSpec.materials.roof) buildingSpec.materials.roof = 'metal';
    }
    if (!buildingSpec.structural_system) {
      buildingSpec.structural_system = 'LOADBEARING';
    }

    console.log('Building spec extracted:', JSON.stringify(buildingSpec).substring(0, 200));

    // Generate title and description from building spec
    const ai_generated_title = buildingSpec.buildingName || `Structure Model`;

    // Build a detailed description based on the building spec
    let descriptionParts = [];

    // Describe the building type and purpose
    descriptionParts.push(`${buildingSpec.buildingType} project featuring a ${buildingSpec.dimensions.length_m}m × ${buildingSpec.dimensions.width_m}m × ${buildingSpec.dimensions.height_m}m structure.`);

    // Add room information if available
    if (buildingSpec.rooms && buildingSpec.rooms.length > 0) {
      descriptionParts.push(`Contains ${buildingSpec.rooms.length} room(s) including ${buildingSpec.rooms.slice(0, 3).map(r => r.name).join(', ')}${buildingSpec.rooms.length > 3 ? ' and more.' : '.'}`);
    }

    // Add ventilation system info
    if (buildingSpec.ventilation && buildingSpec.ventilation.system_type) {
      descriptionParts.push(`Features ${buildingSpec.ventilation.system_type} ventilation system with intake from ${buildingSpec.ventilation.intake_location || 'specified location'}.`);
    }

    // Add equipment information
    if (buildingSpec.equipment && buildingSpec.equipment.length > 0) {
      const equipmentTypes = [...new Set(buildingSpec.equipment.map(e => e.type))];
      descriptionParts.push(`Equipped with ${buildingSpec.equipment.length} equipment item(s) including ${equipmentTypes.slice(0, 3).join(', ')}${equipmentTypes.length > 3 ? ' and others.' : '.'}`);
    }

    const ai_generated_description = descriptionParts.join(' ');

    console.log('Bedrock extraction complete');

    return {
      ...event,
      buildingSpec,
      ai_generated_title,
      ai_generated_description
    };
  } catch (error) {
    console.error('BedrockInvokeIFC error:', error);
    throw error;
  }
};
