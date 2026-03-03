# Canonical Structure Schema (CSS) v1.0

## Overview

The Canonical Structure Schema (CSS) is a versioned, domain-neutral intermediate JSON format used in the Builting pipeline between data extraction and IFC generation. It decouples "what was extracted" from "how to render it," enabling validation, repair, and deterministic IFC generation.

## Design Principles

1. **Domain-neutral** — supports ARCH, CIVIL, TUNNEL, INDUSTRIAL, STRUCTURAL, UNKNOWN
2. **Placement separate from geometry** — enables instancing (same shape, different positions)
3. **Semantic intent preserved** — even PROXY elements store their intended `semanticType`
4. **Confidence-scored** — every element has a confidence score (0.0–1.0) determining IFC mapping
5. **Source-attributed** — every element tracks its data source (DWG, LLM, VSM, etc.)
6. **Meters-normalized** — all values in meters, `unitNormalizationApplied` tracks conversion
7. **Deterministic IDs** — `elem-{sha256(geometry+placement).slice(0,12)}` for stable diffs and caching

## Schema Structure

### Top Level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cssVersion` | `"1.0"` | Yes | Schema version |
| `domain` | enum | Yes | ARCH, CIVIL, TUNNEL, INDUSTRIAL, STRUCTURAL, UNKNOWN |
| `facility` | object | Yes | Project/facility metadata |
| `levelsOrSegments` | array | Yes | Spatial containers (min 1) |
| `elements` | array | Yes | All model elements |
| `metadata` | object | Yes | Pipeline metadata |

### Facility

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Facility name (used as IFC project name) |
| `type` | string | No | e.g., "office", "warehouse", "tunnel" |
| `description` | string | No | AI-generated or user description |
| `units` | enum | Yes | M, FT, MIXED_UNKNOWN (all values normalized to meters) |
| `crs` | string/null | No | Coordinate Reference System (e.g., EPSG:4326) |
| `localGrid` | object/null | No | Local grid definition |
| `origin` | Point3D | Yes | Project origin (meters) |
| `axes` | enum | Yes | RIGHT_HANDED_Z_UP (only supported value) |

### Levels or Segments

Type-discriminated spatial containers:

**STOREY** (architectural floors):
| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `type` | Yes | "STOREY" |
| `name` | Yes | e.g., "Ground Floor" |
| `elevation_m` | Yes | Floor elevation in meters |
| `height_m` | Yes | Floor-to-floor height in meters |

**SEGMENT** (tunnel/civil alignment segments):
| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `type` | Yes | "SEGMENT" |
| `name` | Yes | e.g., "Branch 1" |
| `startChainage_m` | Yes* | Start chainage along alignment |
| `endChainage_m` | Yes* | End chainage along alignment |
| `startNode` | Yes* | Start node ID for graph connectivity |
| `endNode` | Yes* | End node ID for graph connectivity |

*Either chainage pair OR node pair required.

**ZONE** (industrial/undefined areas):
| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `type` | Yes | "ZONE" |
| `name` | Yes | e.g., "Mechanical Area" |
| `boundingExtents` | Yes | BoundingBox (min/max Point3D) |

### Elements

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Deterministic: `elem-{hash}` |
| `type` | enum | Yes | WALL, SLAB, COLUMN, BEAM, DOOR, WINDOW, SPACE, EQUIPMENT, TUNNEL_SEGMENT, DUCT, OPENING, PROXY |
| `semanticType` | string | No | Intended IFC type (e.g., "IfcWallStandardCase"). Preserved even for PROXY. |
| `name` | string | Yes | Human-readable name |
| `placement` | Placement | Yes | Position + orientation (separate from geometry) |
| `geometry` | Geometry | Yes | Shape definition |
| `container` | string | Yes | Reference to levelsOrSegments.id |
| `relationships` | array | No | CONTAINS, VOIDS, FILLS, CONNECTS_TO, SUPPORTS, AGGREGATES |
| `properties` | object | No | Arbitrary key-value pairs → IFC property sets |
| `material` | Material | No | Material name + RGB color + transparency |
| `confidence` | number | Yes | 0.0 (unknown) to 1.0 (certain) |
| `source` | enum | Yes | DWG, PDF, XLSX, DOCX, VSM, LLM, DEFAULT |

### Placement (IfcLocalPlacement analog)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `origin` | Point3D | Yes | Local origin in meters |
| `axis` | Direction3D | No | Local Z-axis (default: 0,0,1) |
| `refDirection` | Direction3D | No | Local X-axis (default: 1,0,0) |

### Geometry (shape only)

**EXTRUSION** — profile swept along direction:
| Field | Required | Description |
|-------|----------|-------------|
| `method` | Yes | "EXTRUSION" |
| `profile` | Yes | RECTANGLE, CIRCLE, or ARBITRARY cross-section |
| `direction` | No | Sweep direction (default: 0,0,1 = vertical) |
| `depth` | Yes | Extrusion depth in meters |

**SWEEP** — profile swept along placement direction:
| Field | Required | Description |
|-------|----------|-------------|
| `method` | Yes | "SWEEP" |
| `profile` | Yes | Cross-section profile |
| `depth` | Yes | Sweep length in meters |

**MESH** — arbitrary triangulated surface:
| Field | Required | Description |
|-------|----------|-------------|
| `method` | Yes | "MESH" |
| `vertices` | Yes | Array of Point3D vertex positions |
| `faces` | Yes | Array of integer index arrays (min 3 per face) |

### Confidence → IFC Mapping

| Confidence | Output Mode | IFC Entity |
|-----------|-------------|------------|
| >= 0.7 | FULL_SEMANTIC | Proper type (IfcWallStandardCase, IfcSlab, etc.) |
| >= 0.7 | HYBRID | Proper type |
| < 0.7 | HYBRID | IfcBuildingElementProxy + Pset_ProxyMetadata |
| any | PROXY_ONLY | IfcBuildingElementProxy (geometry preserved) |

### Metadata

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceFiles` | array | No | Per-file parse status and role |
| `outputMode` | enum | Yes | FULL_SEMANTIC, HYBRID, PROXY_ONLY |
| `validationStatus` | enum | Yes | PENDING, PASSED, REPAIRED, NEEDS_REVIEW |
| `unitNormalizationApplied` | boolean | No | Whether units have been converted to meters |
| `cssHash` | string/null | No | SHA-256 for caching |
| `elementCounts` | object | No | Count by element type |
| `bbox` | BoundingBox | No | Model bounding box |
| `repairLog` | array | No | Log of repairs applied |

## Pipeline Integration

```
ExtractBuildingSpec → CSS JSON
  → SaveCSSSnapshot (to S3)
  → ValidateCSS
  → RepairCSS (if needed)
  → NormalizeGeometry
  → GenerateIFC (CSS → IFC4)
  → ValidateIFC
  → StoreIFC
```

## Invariants

1. All numeric values are in meters (after normalization)
2. Every element has `placement` + `geometry` + `container`
3. `container` always references a valid `levelsOrSegments.id`
4. PROXY_ONLY mode never fails — guaranteed renderable output
5. `semanticType` is preserved even when `type` is downgraded to PROXY
6. Relationship targets must resolve to existing element IDs (or be removed during repair)
