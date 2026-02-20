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

    // Build Claude message content with files
    const messageContent = [
      {
        type: 'text',
        text: `You are an expert in interpreting architectural and engineering documents to extract building specifications.
Extract structured data from the provided files and return it as a JSON object. This JSON will be converted to an IFC 3D model by another system.

═══════════════════════════════════════════════════════════════
REQUIRED JSON STRUCTURE:
═══════════════════════════════════════════════════════════════
Return ONLY valid JSON (no markdown, no explanations). The structure MUST be:

{
  "buildingName": "string - descriptive name for the building/structure",
  "buildingType": "string - BUILDING, WAREHOUSE, TUNNEL, FACILITY, WAREHOUSE, PARKING, etc.",
  "dimensions": {
    "length_m": number - main length dimension in metres,
    "width_m": number - width dimension in metres,
    "height_m": number - height/depth dimension in metres
  },
  "elevations": {
    "floor_level_m": number - ground level elevation (default 0.0),
    "portal_west_m": number - west portal/entrance elevation if applicable,
    "portal_east_m": number - east portal/entrance elevation if applicable
  },
  "rooms": [
    {
      "name": "string - room name/identifier",
      "length_m": number,
      "width_m": number,
      "height_m": number,
      "x_position_m": number - X offset from origin,
      "y_position_m": number - Y offset from origin
    }
  ],
  "ventilation": {
    "system_type": "string - e.g. 'natural', 'mechanical', 'hybrid'",
    "intake_location": "string - e.g. 'West', 'North'",
    "exhaust_location": "string - e.g. 'East', 'South'"
  },
  "equipment": [
    {
      "name": "string - equipment identifier",
      "type": "string - GENERATOR, PUMP, FAN, COMPRESSOR, TRANSFORMER, BATTERY, CONVERTER, etc.",
      "x_position_m": number,
      "y_position_m": number
    }
  ]
}

═══════════════════════════════════════════════════════════════
EXTRACTION GUIDELINES:
═══════════════════════════════════════════════════════════════
1. buildingName: Look for project title, structure name, or descriptive text in documents
2. buildingType: Infer from content (tunnel = TUNNEL, warehouse = WAREHOUSE, facility = FACILITY, building = BUILDING, etc.)
3. dimensions: Convert any imperial/feet measurements to METRES (1 foot = 0.3048 m, 1 inch = 0.0254 m)
4. elevations: Extract portal/grade elevations if available; if not specified, portal_east = floor_level
5. rooms: Extract if floor plans or room layouts are mentioned in documents
6. ventilation: Look for HVAC, ventilation, fan, air system, duct, intake, exhaust mentions
7. equipment: Extract any mentioned equipment (generators, pumps, transformers, compressors, fans, batteries, converters)
8. Use realistic estimates: If dimensions aren't explicit, infer from context and document descriptions
9. ALL DIMENSIONS AND ELEVATIONS MUST BE IN METRES
10. Return empty arrays [] or empty objects {} for sections with no information in documents
11. Ensure JSON is valid (no trailing commas, proper quotes, no comments)

═══════════════════════════════════════════════════════════════

Building Description:
${descriptionContent || '(No description provided)'}

${unsupportedFiles.length > 0 ? `\nAdditional files provided (type: ${unsupportedFiles.join(', ')}): Extract any dimensions, equipment, or layout information if visible` : ''}

═══════════════════════════════════════════════════════════════
YOUR TASK:
═══════════════════════════════════════════════════════════════
Extract building specification from the above information and return ONLY the JSON object.
NO markdown, NO explanations, NO extra text - just the valid JSON conforming to the schema above.`
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

    // Validate required fields
    if (!buildingSpec.buildingName) {
      buildingSpec.buildingName = 'Structure';
    }
    if (!buildingSpec.buildingType) {
      buildingSpec.buildingType = 'BUILDING';
    }
    if (!buildingSpec.dimensions) {
      buildingSpec.dimensions = { length_m: 100, width_m: 50, height_m: 6 };
    }
    if (!buildingSpec.elevations) {
      buildingSpec.elevations = {};
    }
    if (buildingSpec.elevations.floor_level_m === undefined) {
      buildingSpec.elevations.floor_level_m = 0.0;
    }
    if (buildingSpec.elevations.portal_east_m === undefined) {
      buildingSpec.elevations.portal_east_m = buildingSpec.dimensions.length_m;
    }
    if (!buildingSpec.rooms) {
      buildingSpec.rooms = [];
    }
    if (!buildingSpec.ventilation) {
      buildingSpec.ventilation = {};
    }
    if (!buildingSpec.equipment) {
      buildingSpec.equipment = [];
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
