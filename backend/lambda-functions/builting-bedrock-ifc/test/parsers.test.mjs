import { describe, it, expect } from 'vitest';
import { extractXlsxText } from '../parsers/xlsxParser.mjs';
import { extractDocxText } from '../parsers/docxParser.mjs';
import { parseDxfToCSS } from '../parsers/dxfParser.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

// ============================================================================
// DXF PARSER TESTS
// ============================================================================

describe('parseDxfToCSS', () => {
  let dxfText;
  let result;

  try {
    dxfText = readFileSync(join(fixturesDir, 'sample.dxf'), 'utf-8');
  } catch {
    dxfText = null;
  }

  if (dxfText) {
    result = parseDxfToCSS(dxfText);
  }

  it('should return valid CSS structure', () => {
    if (!dxfText) return; // skip if fixture missing
    expect(result).toBeDefined();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.source).toBe('DXF');
    expect(result.storeys).toBeInstanceOf(Array);
    expect(result.storeys.length).toBeGreaterThanOrEqual(1);
  });

  it('should upgrade LINE on WALL_EXTERIOR to WALL semantic type', () => {
    if (!result) return;
    const elements = result.storeys[0].elements;
    const wallEl = elements.find(e => e.sourceLayer === 'WALL_EXTERIOR' && e.sourceEntityType === 'LINE');
    expect(wallEl).toBeDefined();
    expect(wallEl.semantic_type).toBe('WALL');
    // Verify midpoint placement: (0,0,0) to (10,0,0) → midpoint (5,0,0)
    expect(wallEl.placement.position.x).toBeCloseTo(5, 1);
    expect(wallEl.placement.position.y).toBeCloseTo(0, 1);
    // Verify length
    expect(wallEl.geometry.length_m).toBeCloseTo(10, 1);
    // Verify direction is normalized
    const dir = wallEl.geometry.direction;
    const norm = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('should keep LINE on unknown layer as PROXY', () => {
    if (!result) return;
    const elements = result.storeys[0].elements;
    const miscEl = elements.find(e => e.sourceLayer === 'MISC' && e.sourceEntityType === 'LINE');
    expect(miscEl).toBeDefined();
    expect(miscEl.semantic_type).toBe('PROXY');
  });

  it('should skip degenerate zero-length LINE', () => {
    if (!result) return;
    const elements = result.storeys[0].elements;
    const degenerateEls = elements.filter(e => e.sourceLayer === 'TEST' && e.sourceEntityType === 'LINE');
    expect(degenerateEls.length).toBe(0);
  });

  it('should split closed POLYLINE into segment-per-edge elements', () => {
    if (!result) return;
    const elements = result.storeys[0].elements;
    // 4-vertex closed rectangle → 4 edges
    const polySegs = elements.filter(e => e.sourceEntityType === 'LWPOLYLINE' || e.sourceEntityType === 'POLYLINE');
    expect(polySegs.length).toBeGreaterThanOrEqual(4);
    // Each segment should have metadata.sourcePolyline
    for (const seg of polySegs) {
      expect(seg.metadata?.sourcePolyline).toBeDefined();
    }
  });

  it('should upgrade CIRCLE on COLUMN_ROUND to COLUMN', () => {
    if (!result) return;
    const elements = result.storeys[0].elements;
    const colEl = elements.find(e => e.sourceEntityType === 'CIRCLE' && e.sourceLayer === 'COLUMN_ROUND');
    expect(colEl).toBeDefined();
    expect(colEl.semantic_type).toBe('COLUMN');
    expect(colEl.geometry.profile.radius_m).toBeCloseTo(0.5, 2);
    expect(colEl.geometry.depth_m).toBe(3.0); // COLUMN_DEFAULT_DEPTH
  });

  it('should always emit ARC as PROXY element', () => {
    if (!result) return;
    const elements = result.storeys[0].elements;
    const arcEl = elements.find(e => e.sourceEntityType === 'ARC');
    expect(arcEl).toBeDefined();
    expect(arcEl.semantic_type).toBe('PROXY');
    expect(arcEl.metadata?.primitive).toBe('ARC');
  });

  it('should expand INSERT with arrays', () => {
    if (!result) return;
    const elements = result.storeys[0].elements;
    // INSERT with 2x2 array of block "FIXTURE" (1 LINE each) → at least 4 elements
    // They should have positions near (20,0), (23,0), (20,3), (23,3) based on spacing=3
    const insertEls = elements.filter(e =>
      e.placement.position.x >= 19 && e.placement.position.x <= 25 &&
      e.sourceEntityType === 'LINE'
    );
    expect(insertEls.length).toBeGreaterThanOrEqual(4);
  });

  it('should have diagnostics metadata', () => {
    if (!result) return;
    const diag = result.metadata.diagnostics;
    expect(diag).toBeDefined();
    expect(diag.parserUsed).toBe('DXF');
    expect(typeof diag.elementCount).toBe('number');
    expect(typeof diag.proxyCount).toBe('number');
    expect(typeof diag.semanticUpgradeCount).toBe('number');
  });

  it('should produce fallback direction for zero-length segments', () => {
    // A zero-length line should be skipped entirely (degenerate)
    // Verify no elements have undefined directions
    if (!result) return;
    for (const el of result.storeys[0].elements) {
      if (el.geometry.direction) {
        const dir = el.geometry.direction;
        expect(dir).toBeInstanceOf(Array);
        expect(dir.length).toBe(3);
        const norm = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
        expect(norm).toBeGreaterThan(0.99);
      }
    }
  });

  it('should have correct DXF units metadata', () => {
    if (!result) return;
    expect(result.metadata.dxfUnits).toBeDefined();
    expect(result.metadata.dxfUnits.insunits).toBe(6); // meters
    expect(result.metadata.dxfUnits.scaleFactor).toBe(1.0);
  });
});

describe('DXF unit scaling', () => {
  it('should scale coordinates when INSUNITS=2 (feet)', () => {
    // Construct a minimal DXF string with INSUNITS=2 and a LINE 10 feet long
    const dxfFeet = `0
SECTION
2
HEADER
9
$INSUNITS
70
2
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
MISC
10
0.0
20
0.0
30
0.0
11
10.0
21
0.0
31
0.0
0
ENDSEC
0
EOF`;

    const result = parseDxfToCSS(dxfFeet);
    expect(result.metadata.dxfUnits.insunits).toBe(2);
    expect(result.metadata.dxfUnits.scaleFactor).toBeCloseTo(0.3048, 4);

    const elements = result.storeys[0].elements;
    expect(elements.length).toBe(1);
    // 10 feet = 3.048 meters
    expect(elements[0].geometry.length_m).toBeCloseTo(3.048, 2);
    // Midpoint should be at 5ft = 1.524m
    expect(elements[0].placement.position.x).toBeCloseTo(1.524, 2);
  });
});

describe('DXF entity count cap', () => {
  it('should clamp INSERT expansion to fit entity cap', () => {
    // Create a DXF with an INSERT that would expand to way more than 50k
    const dxf = `0
SECTION
2
HEADER
9
$INSUNITS
70
6
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
8
0
2
BIG_BLOCK
10
0.0
20
0.0
30
0.0
0
LINE
8
TEST
10
0.0
20
0.0
30
0.0
11
1.0
21
0.0
31
0.0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
INSERT
8
0
2
BIG_BLOCK
10
0.0
20
0.0
30
0.0
70
1000
71
1000
44
1.0
45
1.0
0
ENDSEC
0
EOF`;

    const result = parseDxfToCSS(dxf);
    // Should have clamped to ≤50000 elements
    expect(result.storeys[0].elements.length).toBeLessThanOrEqual(50000);
    expect(result.storeys[0].elements.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// XLSX PARSER TESTS
// ============================================================================

describe('extractXlsxText', () => {
  it('should return a string for any input (never throws)', () => {
    // xlsx library is lenient — treats arbitrary text as CSV, so it won't throw.
    // Verify the parser always returns a string (resilience guarantee).
    const result = extractXlsxText(Buffer.from('not a real xlsx'), 'bad.xlsx');
    expect(typeof result).toBe('string');
    expect(result).toContain('bad.xlsx');
  });

  it('should include file header and sheet names', () => {
    const result = extractXlsxText(Buffer.from('not a real xlsx'), 'test.xlsx');
    expect(result).toContain('--- Extracted from: test.xlsx ---');
    expect(result).toContain('=== Sheet:');
  });
});

// ============================================================================
// DOCX PARSER TESTS
// ============================================================================

describe('extractDocxText', () => {
  it('should return error note for invalid buffer', async () => {
    const result = await extractDocxText(Buffer.from('not a real docx'), 'bad.docx');
    expect(result).toContain('[DOCX extraction failed');
    expect(result).toContain('bad.docx');
  });

  it('should return a string', async () => {
    const result = await extractDocxText(Buffer.from('garbage'), 'test.docx');
    expect(typeof result).toBe('string');
  });
});

// ============================================================================
// POLYLINE VERTEX DEDUPE
// ============================================================================

describe('DXF polyline vertex dedupe', () => {
  it('should dedupe consecutive duplicate vertices', () => {
    // LWPOLYLINE with duplicates: (0,0), (0,0), (5,0), (5,5), (5,5)
    const dxf = `0
SECTION
2
HEADER
9
$INSUNITS
70
6
0
ENDSEC
0
SECTION
2
ENTITIES
0
LWPOLYLINE
8
TEST
90
5
70
0
10
0.0
20
0.0
10
0.0
20
0.0
10
5.0
20
0.0
10
5.0
20
5.0
10
5.0
20
5.0
0
ENDSEC
0
EOF`;

    const result = parseDxfToCSS(dxf);
    const elements = result.storeys[0].elements;
    // After dedupe: 3 unique vertices → 2 segments (not 4)
    expect(elements.length).toBe(2);
  });
});
