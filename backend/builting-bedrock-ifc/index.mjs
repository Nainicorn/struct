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
        text: `You are an expert IFC4 (ISO 16739-1:2018) file generator. You MUST produce VALID, SYNTACTICALLY CORRECT STEP format code.

═══════════════════════════════════════════════════════════════
CRITICAL SYNTAX RULES (VIOLATIONS BREAK THE FILE):
═══════════════════════════════════════════════════════════════
1. Every entity has unique ID: #1, #2, #3... (sequential, no gaps)
2. Every entity ends with SEMICOLON: #1=IFCPROJECT(...);
3. Parameters separated by COMMAS ONLY (no spaces around commas)
4. NULL values are represented as single: $ (NOT $$ or *, just $)
5. References to other entities: #NUMBER (must exist)
6. Text strings: 'single quotes' (never double quotes)
7. Decimals: 0.5 or 0.5E-3 (never 0,5 or commas)
8. Lists in parentheses: (item1,item2,item3) - no trailing comma
9. Boolean values: .T. or .F. (with dots on both sides)
10. No comments or extra whitespace in DATA section

═══════════════════════════════════════════════════════════════
ENTITY PARAMETER COUNTS (MUST BE EXACT):
═══════════════════════════════════════════════════════════════
IFCPROJECT: (tag,owner,name,description,placement1,placement2,placement3,representationContexts,unitAssignment)
  #1=IFCPROJECT('0x1',#0,'ProjectName',$,#2,$,$,(#3),#4);

IFCAXIS2PLACEMENT3D: (location,axis,refDirection)
  #2=IFCAXIS2PLACEMENT3D(#5,#6,#7);

IFCCARTESIANPOINT: (coordinates)
  #5=IFCCARTESIANPOINT((0.,0.,0.));

IFCDIRECTION: (directionRatios)
  #6=IFCDIRECTION((0.,0.,1.));

IFCUNITASSIGNMENT: (units)
  #4=IFCUNITASSIGNMENT((#8));

IFCWALL/SLAB: (globalId,owner,name,description,objectPlacement,representation,tag)
  #10=IFCWALL('0x10',#0,'Wall',$,#2,$,$);

IFCSHAPEREPRESENTATION: (context,repType,label,items)
  #11=IFCSHAPEREPRESENTATION(#3,'Body','SweptSolid',(#12));

IFCPOLYLINE: (points)
  #12=IFCPOLYLINE((#20,#21,#22,#23,#20));

IFCEXTRUDEDAREASOLID: (sweptArea,position,extrudedDirection,depth)
  #13=IFCEXTRUDEDAREASOLID(#14,#2,#15,5.0);

═══════════════════════════════════════════════════════════════
FILE STRUCTURE (EXACT ORDER):
═══════════════════════════════════════════════════════════════
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('model.ifc','2024-01-01T00:00:00',('Author'),(''),'',' ','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCAPPLICATION(#0,'1.0','IFC Generator','IFC Generator');
[... all other entities ...]
ENDSEC;
END-ISO-10303-21;

═══════════════════════════════════════════════════════════════
WHAT MAKES AN IFC FILE VALID FOR VIEWING:
═══════════════════════════════════════════════════════════════
✓ MUST have geometric entities: IFCPOLYLINE, IFCEXTRUDEDAREASOLID, IFCSHAPEREPRESENTATION
✓ MUST have a building element: IFCWALL, IFCSLAB, IFCBEAM, etc. with geometry
✓ MUST have spatial structure: IFCPROJECT -> IFCSITE/IFCBUILDING -> elements
✓ MUST have proper hierarchical relationships
✗ DO NOT use incomplete entities (always include all required parameters)
✗ DO NOT leave unresolved references (#999 if #999 doesn't exist = error)
✗ DO NOT mix IFC3 and IFC4 syntax

═══════════════════════════════════════════════════════════════

Building Description to Model:
${descriptionContent || '(No description provided)'}

${unsupportedFiles.length > 0 ? `\nSupplementary files provided (may contain relevant info): ${unsupportedFiles.join(', ')}` : ''}

═══════════════════════════════════════════════════════════════
YOUR TASK:
═══════════════════════════════════════════════════════════════
Generate ONLY valid IFC4 file content. NO markdown, NO explanations, NO notes, NO extra text.
The file MUST be parseable by IFC viewers (xeokit, Revit, etc).
Include realistic 3D geometry that represents the described space.
Every entity ID must be sequential starting from #1.
RETURN ONLY THE RAW IFC FILE TEXT.`
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

    // Extract IFC content from response
    let ifcContent = '';
    if (responseBody.content && responseBody.content.length > 0) {
      ifcContent = responseBody.content[0].text || '';
    }

    if (!ifcContent.includes('ISO-10303-21')) {
      console.warn('Generated content may not be valid IFC, checking for content...');
      if (!ifcContent) {
        throw new Error('Bedrock returned empty response');
      }
    }

    // Generate title and description from files and description
    const fileNames = files
      .filter(f => f.name !== 'description.txt')
      .map(f => f.name)
      .join(', ');

    const ai_generated_title = `3D Model: ${renderId.slice(0, 8)}`;
    const ai_generated_description = `Generated IFC model from ${files.length} source files${fileNames ? `: ${fileNames}` : ''}. ${descriptionContent ? `User description: ${descriptionContent.substring(0, 100)}...` : ''}`;

    console.log('IFC generation complete');

    return {
      ...event,
      ifcContent,
      ai_generated_title,
      ai_generated_description
    };
  } catch (error) {
    console.error('BedrockInvokeIFC error:', error);
    throw error;
  }
};
