import { describe, it, expect } from 'vitest';
import { handler } from '../index.mjs';

// Helper to create a minimal valid CSS element
function makeWall(id, origin, direction, depth, profile = { type: 'RECTANGLE', width: 0.3, height: 3.0 }, container = 'level-1') {
  return {
    id,
    element_key: id,
    type: 'WALL',
    name: id,
    container,
    confidence: 0.8,
    source: 'TEST',
    placement: { origin: { x: origin[0], y: origin[1], z: origin[2] } },
    geometry: {
      method: 'EXTRUSION',
      direction: { x: direction[0], y: direction[1], z: direction[2] },
      depth,
      profile,
    },
  };
}

function makeCSS(elements, levels = [{ id: 'level-1', type: 'STOREY', name: 'Ground', elevation_m: 0, height_m: 3 }]) {
  return {
    cssVersion: '1.0',
    facility: { name: 'Test' },
    levelsOrSegments: levels,
    elements,
    metadata: {},
  };
}

// ============================================================================
// WALL MERGE TESTS
// ============================================================================

describe('Wall merge (Phase 6A)', () => {
  it('should merge collinear wall segments into one longer wall', async () => {
    // Two walls along X axis, end-to-end: wall-a ends at x=5, wall-b starts at x=5
    const wallA = makeWall('wall-a', [2.5, 0, 0], [1, 0, 0], 5); // from x=0 to x=5
    const wallB = makeWall('wall-b', [7.5, 0, 0], [1, 0, 0], 5); // from x=5 to x=10
    const css = makeCSS([wallA, wallB]);

    const result = await handler({ css });
    const walls = result.css.elements.filter(e => e.type === 'WALL');

    // Should merge into one wall
    expect(walls.length).toBe(1);
    expect(walls[0].metadata?.mergedFrom).toBeDefined();
    expect(walls[0].metadata.mergedFrom).toContain('wall-a');
    expect(walls[0].metadata.mergedFrom).toContain('wall-b');
  });

  it('should NOT merge non-collinear walls (angle > 3 degrees)', async () => {
    // Two walls at roughly 90 degrees
    const wallA = makeWall('wall-a', [2.5, 0, 0], [1, 0, 0], 5);
    const wallB = makeWall('wall-b', [5, 2.5, 0], [0, 1, 0], 5);
    const css = makeCSS([wallA, wallB]);

    const result = await handler({ css });
    const walls = result.css.elements.filter(e => e.type === 'WALL');
    expect(walls.length).toBe(2);
  });

  it('should NOT merge walls on different storeys', async () => {
    const levels = [
      { id: 'level-1', type: 'STOREY', name: 'Ground', elevation_m: 0, height_m: 3 },
      { id: 'level-2', type: 'STOREY', name: 'First', elevation_m: 3, height_m: 3 },
    ];
    const wallA = makeWall('wall-a', [2.5, 0, 0], [1, 0, 0], 5, undefined, 'level-1');
    const wallB = makeWall('wall-b', [7.5, 0, 0], [1, 0, 0], 5, undefined, 'level-2');
    const css = makeCSS([wallA, wallB], levels);

    const result = await handler({ css });
    const walls = result.css.elements.filter(e => e.type === 'WALL');
    expect(walls.length).toBe(2);
  });

  it('should NOT merge walls with different thickness', async () => {
    const wallA = makeWall('wall-a', [2.5, 0, 0], [1, 0, 0], 5, { type: 'RECTANGLE', width: 0.3, height: 3 });
    const wallB = makeWall('wall-b', [7.5, 0, 0], [1, 0, 0], 5, { type: 'RECTANGLE', width: 0.6, height: 3 });
    const css = makeCSS([wallA, wallB]);

    const result = await handler({ css });
    const walls = result.css.elements.filter(e => e.type === 'WALL');
    expect(walls.length).toBe(2);
  });
});

// ============================================================================
// OPENING INFERENCE TESTS
// ============================================================================

describe('Opening inference (Phase 6B)', () => {
  it('should assign hostWallKey to door near wall', async () => {
    const wall = makeWall('wall-1', [5, 0, 0], [1, 0, 0], 10);
    const door = {
      id: 'door-1',
      element_key: 'door-1',
      type: 'DOOR',
      name: 'Main Door',
      container: 'level-1',
      confidence: 0.8,
      source: 'TEST',
      placement: { origin: { x: 5, y: 0.2, z: 0 } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 0.9, height: 2.1 }, depth: 2.1, direction: { x: 0, y: 0, z: 1 } },
    };
    const css = makeCSS([wall, door]);

    const result = await handler({ css });
    const doors = result.css.elements.filter(e => e.type === 'DOOR');
    expect(doors.length).toBe(1);
    expect(doors[0].metadata?.hostWallKey).toBe('wall-1');
  });

  it('should NOT assign hostWallKey when door is far from any wall', async () => {
    const wall = makeWall('wall-1', [5, 0, 0], [1, 0, 0], 10);
    const door = {
      id: 'door-1',
      element_key: 'door-1',
      type: 'DOOR',
      name: 'Far Door',
      container: 'level-1',
      confidence: 0.8,
      source: 'TEST',
      placement: { origin: { x: 50, y: 50, z: 0 } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 0.9, height: 2.1 }, depth: 2.1, direction: { x: 0, y: 0, z: 1 } },
    };
    const css = makeCSS([wall, door]);

    const result = await handler({ css });
    const doors = result.css.elements.filter(e => e.type === 'DOOR');
    expect(doors.length).toBe(1);
    expect(doors[0].metadata?.hostWallKey).toBeUndefined();
  });
});

// ============================================================================
// SLAB INFERENCE TESTS
// ============================================================================

describe('Slab inference (Phase 6C)', () => {
  it('should assign FLOOR slabType for ground storey slab', async () => {
    const levels = [
      { id: 'level-1', type: 'STOREY', name: 'Ground', elevation_m: 0, height_m: 3 },
      { id: 'level-2', type: 'STOREY', name: 'First', elevation_m: 3, height_m: 3 },
    ];
    const slab = {
      id: 'slab-1',
      element_key: 'slab-1',
      type: 'SLAB',
      name: 'Ground Floor Slab',
      container: 'level-1',
      confidence: 0.8,
      source: 'TEST',
      placement: { origin: { x: 5, y: 5, z: 0 } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 10, height: 10 }, depth: 0.3, direction: { x: 0, y: 0, z: 1 } },
    };
    const css = makeCSS([slab], levels);

    const result = await handler({ css });
    const slabs = result.css.elements.filter(e => e.type === 'SLAB');
    expect(slabs[0].properties.slabType).toBe('FLOOR');
  });

  it('should assign ROOF slabType for topmost storey slab', async () => {
    const levels = [
      { id: 'level-1', type: 'STOREY', name: 'Ground', elevation_m: 0, height_m: 3 },
      { id: 'level-2', type: 'STOREY', name: 'Roof', elevation_m: 3, height_m: 0.5 },
    ];
    const slab = {
      id: 'slab-roof',
      element_key: 'slab-roof',
      type: 'SLAB',
      name: 'Roof Slab',
      container: 'level-2',
      confidence: 0.8,
      source: 'TEST',
      placement: { origin: { x: 5, y: 5, z: 3 } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 10, height: 10 }, depth: 0.3, direction: { x: 0, y: 0, z: 1 } },
    };
    const css = makeCSS([slab], levels);

    const result = await handler({ css });
    const slabs = result.css.elements.filter(e => e.type === 'SLAB');
    expect(slabs[0].properties.slabType).toBe('ROOF');
  });
});
