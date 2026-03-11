import { describe, it, expect, vi } from 'vitest';

// We need to test enrichCSS and buildSupplementaryText which are defined in index.mjs
// Since they're not exported, we'll re-implement the core logic for testing
// In production, these would be extracted to a module and imported

// ============================================================================
// MOCK HELPERS
// ============================================================================

const ENRICHMENT_WHITELIST = new Set(['name', 'description', 'materials', 'psets']);
const ENRICHMENT_GEOMETRY_FIELDS = new Set([
  'placement', 'dimensions', 'width', 'height', 'depth', 'direction',
  'elevation', 'semantic_type', 'profile', 'length_m', 'depth_m',
  'width_m', 'height_m', 'geometry', 'position'
]);

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

function applyPatches(cssData, patchData) {
  const elementMap = new Map();
  for (const storey of (cssData.storeys || [])) {
    for (const el of (storey.elements || [])) {
      if (el.element_key) elementMap.set(el.element_key, el);
    }
  }

  let appliedCount = 0;
  const rejected = [];

  for (const patch of patchData.patches) {
    const element = elementMap.get(patch.element_key);
    if (!element) continue;

    for (const [field, value] of Object.entries(patch.updates)) {
      if (ENRICHMENT_GEOMETRY_FIELDS.has(field)) {
        rejected.push({ element_key: patch.element_key, field });
        continue;
      }
      if (!ENRICHMENT_WHITELIST.has(field)) {
        rejected.push({ element_key: patch.element_key, field, reason: 'unknown' });
        continue;
      }
      element[field] = value;
    }
    appliedCount++;
  }

  return { appliedCount, rejected };
}

function buildSupplementaryText(files) {
  const MAX_CHARS_PER_FILE = 50_000;
  const MAX_TOTAL = 120_000;
  const truncatedFiles = [];

  let sections = files.map(f => {
    const header = `=== File: ${f.name} (${f.contentType || 'text/plain'}) ===`;
    let content = f.content || '';
    const original = content.length;
    if (content.length > MAX_CHARS_PER_FILE) {
      content = content.slice(0, MAX_CHARS_PER_FILE) + '\n...[truncated]';
      truncatedFiles.push({ name: f.name, originalChars: original, keptChars: MAX_CHARS_PER_FILE });
    }
    return { name: f.name, text: `${header}\n${content}`, length: header.length + 1 + content.length, originalChars: original };
  });

  const total = sections.reduce((s, sec) => s + sec.length, 0);
  if (total > MAX_TOTAL) {
    const perFile = Math.floor(MAX_TOTAL / sections.length);
    sections = sections.map(s => {
      if (s.length > perFile) {
        const truncated = s.text.slice(0, perFile) + '\n...[truncated]';
        if (!truncatedFiles.find(t => t.name === s.name)) {
          truncatedFiles.push({ name: s.name, originalChars: s.originalChars, keptChars: perFile });
        }
        return { ...s, text: truncated };
      }
      return s;
    });
  }

  return { text: sections.map(s => s.text).join('\n\n'), truncatedFiles };
}

// ============================================================================
// SAMPLE CSS DATA
// ============================================================================

function makeSampleCSS() {
  return {
    metadata: {
      source: 'DXF',
      confidence: 0.5,
      schema_version: '1.0',
      diagnostics: { parserUsed: 'DXF', elementCount: 3, proxyCount: 1, semanticUpgradeCount: 2, enrichmentApplied: false, enrichmentPatchCount: 0, truncatedFiles: [] }
    },
    storeys: [{
      id: 'storey-0',
      name: 'Ground Floor',
      elevation_m: 0,
      height_m: 3.5,
      elements: [
        {
          element_key: 'dxf_WALL_EXTERIOR_LINE_5_0_10',
          id: 'elem-001',
          semantic_type: 'WALL',
          placement: { position: { x: 5, y: 0, z: 0 } },
          geometry: { length_m: 10, direction: [1, 0, 0], profile: { type: 'rectangle', width_m: 0.1, height_m: 0.1 }, depth_m: 10 },
        },
        {
          element_key: 'dxf_MISC_LINE_2.5_2.5_7.07',
          id: 'elem-002',
          semantic_type: 'PROXY',
          placement: { position: { x: 2.5, y: 2.5, z: 0 } },
          geometry: { length_m: 7.07, direction: [0.707, 0.707, 0], profile: { type: 'rectangle', width_m: 0.1, height_m: 0.1 }, depth_m: 7.07 },
        },
        {
          element_key: 'dxf_COLUMN_ROUND_CIRCLE_5_5_0.5',
          id: 'elem-003',
          semantic_type: 'COLUMN',
          placement: { position: { x: 5, y: 5, z: 0 } },
          geometry: { profile: { type: 'circle', radius_m: 0.5 }, depth_m: 3.0 },
        }
      ]
    }]
  };
}

// ============================================================================
// ENRICHMENT PATCH VALIDATION TESTS
// ============================================================================

describe('validatePatchSchema', () => {
  it('should accept valid v1.0 patch schema', () => {
    expect(validatePatchSchema({
      version: '1.0',
      patches: [{ element_key: 'key1', updates: { name: 'Test' } }]
    })).toBe(true);
  });

  it('should reject missing version', () => {
    expect(validatePatchSchema({
      patches: [{ element_key: 'key1', updates: { name: 'Test' } }]
    })).toBe(false);
  });

  it('should reject wrong version', () => {
    expect(validatePatchSchema({
      version: '2.0',
      patches: []
    })).toBe(false);
  });

  it('should reject unknown top-level keys', () => {
    expect(validatePatchSchema({
      version: '1.0',
      patches: [],
      extra_field: true
    })).toBe(false);
  });

  it('should reject non-string element_key', () => {
    expect(validatePatchSchema({
      version: '1.0',
      patches: [{ element_key: 42, updates: { name: 'Test' } }]
    })).toBe(false);
  });

  it('should reject missing updates object', () => {
    expect(validatePatchSchema({
      version: '1.0',
      patches: [{ element_key: 'key1' }]
    })).toBe(false);
  });

  it('should accept empty patches array', () => {
    expect(validatePatchSchema({
      version: '1.0',
      patches: []
    })).toBe(true);
  });
});

// ============================================================================
// ENRICHMENT MERGE LOGIC TESTS
// ============================================================================

describe('enrichment merge logic', () => {
  it('should apply name and materials from patches', () => {
    const css = makeSampleCSS();
    const patches = {
      version: '1.0',
      patches: [{
        element_key: 'dxf_WALL_EXTERIOR_LINE_5_0_10',
        updates: { name: 'Main Wall', materials: ['concrete', 'paint'] }
      }]
    };

    const { appliedCount } = applyPatches(css, patches);
    expect(appliedCount).toBe(1);

    const wall = css.storeys[0].elements[0];
    expect(wall.name).toBe('Main Wall');
    expect(wall.materials).toEqual(['concrete', 'paint']);
  });

  it('should NOT change geometry after enrichment', () => {
    const css = makeSampleCSS();
    const originalPlacement = JSON.parse(JSON.stringify(css.storeys[0].elements[0].placement));
    const originalGeometry = JSON.parse(JSON.stringify(css.storeys[0].elements[0].geometry));

    const patches = {
      version: '1.0',
      patches: [{
        element_key: 'dxf_WALL_EXTERIOR_LINE_5_0_10',
        updates: { name: 'Updated Wall', description: 'A wall' }
      }]
    };

    applyPatches(css, patches);
    expect(css.storeys[0].elements[0].placement).toEqual(originalPlacement);
    expect(css.storeys[0].elements[0].geometry).toEqual(originalGeometry);
  });

  it('should reject geometry patches and log them', () => {
    const css = makeSampleCSS();
    const patches = {
      version: '1.0',
      patches: [{
        element_key: 'dxf_WALL_EXTERIOR_LINE_5_0_10',
        updates: { placement: { position: { x: 99, y: 99, z: 99 } }, name: 'Kept' }
      }]
    };

    const { rejected } = applyPatches(css, patches);
    expect(rejected.length).toBe(1);
    expect(rejected[0].field).toBe('placement');
    // Name should still be applied
    expect(css.storeys[0].elements[0].name).toBe('Kept');
    // Placement should NOT be changed
    expect(css.storeys[0].elements[0].placement.position.x).toBe(5);
  });

  it('should reject patches with unknown fields', () => {
    const css = makeSampleCSS();
    const patches = {
      version: '1.0',
      patches: [{
        element_key: 'dxf_WALL_EXTERIOR_LINE_5_0_10',
        updates: { foobar: 'should be rejected', name: 'Kept' }
      }]
    };

    const { rejected } = applyPatches(css, patches);
    expect(rejected.length).toBe(1);
    expect(rejected[0].field).toBe('foobar');
    expect(rejected[0].reason).toBe('unknown');
    expect(css.storeys[0].elements[0].name).toBe('Kept');
    expect(css.storeys[0].elements[0].foobar).toBeUndefined();
  });

  it('should skip unmatched element keys', () => {
    const css = makeSampleCSS();
    const patches = {
      version: '1.0',
      patches: [{
        element_key: 'nonexistent_key_123',
        updates: { name: 'Ghost Element' }
      }]
    };

    const { appliedCount } = applyPatches(css, patches);
    expect(appliedCount).toBe(0);
  });

  it('should reject semantic_type changes', () => {
    const css = makeSampleCSS();
    const patches = {
      version: '1.0',
      patches: [{
        element_key: 'dxf_MISC_LINE_2.5_2.5_7.07',
        updates: { semantic_type: 'WALL', name: 'Kept' }
      }]
    };

    const { rejected } = applyPatches(css, patches);
    expect(rejected.some(r => r.field === 'semantic_type')).toBe(true);
    expect(css.storeys[0].elements[1].semantic_type).toBe('PROXY');
  });
});

// ============================================================================
// SUPPLEMENTARY TEXT TESTS
// ============================================================================

describe('buildSupplementaryText', () => {
  it('should build text with file headers', () => {
    const files = [
      { name: 'specs.txt', content: 'Building specs here', contentType: 'text/plain' },
      { name: 'notes.txt', content: 'Additional notes', contentType: 'text/plain' }
    ];
    const { text } = buildSupplementaryText(files);
    expect(text).toContain('=== File: specs.txt (text/plain) ===');
    expect(text).toContain('=== File: notes.txt (text/plain) ===');
    expect(text).toContain('Building specs here');
    expect(text).toContain('Additional notes');
  });

  it('should truncate individual files exceeding 50k chars', () => {
    const longContent = 'x'.repeat(60000);
    const files = [{ name: 'big.txt', content: longContent, contentType: 'text/plain' }];
    const { text, truncatedFiles } = buildSupplementaryText(files);
    expect(text).toContain('...[truncated]');
    expect(truncatedFiles.length).toBe(1);
    expect(truncatedFiles[0].name).toBe('big.txt');
    expect(truncatedFiles[0].originalChars).toBe(60000);
    expect(truncatedFiles[0].keptChars).toBe(50000);
  });

  it('should apply round-robin truncation when total exceeds 120k', () => {
    const files = [
      { name: 'a.txt', content: 'a'.repeat(80000), contentType: 'text/plain' },
      { name: 'b.txt', content: 'b'.repeat(80000), contentType: 'text/plain' },
    ];
    const { text, truncatedFiles } = buildSupplementaryText(files);
    // Total would be ~160k, needs round-robin
    expect(truncatedFiles.length).toBeGreaterThanOrEqual(1);
    expect(text.length).toBeLessThanOrEqual(130000); // some overhead from headers
  });
});
