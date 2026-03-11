#!/usr/bin/env python3
"""
Regression tests for the CSS v1.0 IFC4 generator.
Tests generate_ifc4_from_css() with various scenarios.
Run with: python test_ifc4.py
Requires: ifcopenshell (installed in Docker container or local conda env)
"""

import json
import sys
import os
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lambda_function import generate_ifc4_from_css, normalize_vector, sanitize_axis_ref


# ============================================================================
# TEST FIXTURES
# ============================================================================

def make_3storey_css():
    """Create a 3-storey office building CSS v1.0 fixture (3.5m per floor)."""
    return {
        "cssVersion": "1.0",
        "domain": "ARCH",
        "facility": {
            "name": "Test Office",
            "type": "office",
            "units": "M",
            "origin": {"x": 0, "y": 0, "z": 0},
            "axes": "RIGHT_HANDED_Z_UP"
        },
        "levelsOrSegments": [
            {"id": "level-1", "type": "STOREY", "name": "Ground Floor",
             "elevation_m": 0.0, "height_m": 3.5},
            {"id": "level-2", "type": "STOREY", "name": "First Floor",
             "elevation_m": 3.5, "height_m": 3.5},
            {"id": "level-3", "type": "STOREY", "name": "Second Floor",
             "elevation_m": 7.0, "height_m": 3.5}
        ],
        "elements": [
            {
                "id": "elem-wall-001", "type": "WALL", "name": "South Wall GF",
                "placement": {"origin": {"x": 5, "y": 0.15, "z": 0}},
                "geometry": {
                    "method": "EXTRUSION",
                    "profile": {"type": "RECTANGLE", "width": 10, "height": 0.3},
                    "direction": {"x": 0, "y": 0, "z": 1},
                    "depth": 3.5
                },
                "container": "level-1", "confidence": 0.9, "source": "LLM",
                "material": {"name": "concrete"}
            },
            {
                "id": "elem-wall-002", "type": "WALL", "name": "South Wall 1F",
                "placement": {"origin": {"x": 5, "y": 0.15, "z": 3.5}},
                "geometry": {
                    "method": "EXTRUSION",
                    "profile": {"type": "RECTANGLE", "width": 10, "height": 0.3},
                    "direction": {"x": 0, "y": 0, "z": 1},
                    "depth": 3.5
                },
                "container": "level-2", "confidence": 0.9, "source": "LLM",
                "material": {"name": "concrete"}
            },
            {
                "id": "elem-wall-003", "type": "WALL", "name": "South Wall 2F",
                "placement": {"origin": {"x": 5, "y": 0.15, "z": 7.0}},
                "geometry": {
                    "method": "EXTRUSION",
                    "profile": {"type": "RECTANGLE", "width": 10, "height": 0.3},
                    "direction": {"x": 0, "y": 0, "z": 1},
                    "depth": 3.5
                },
                "container": "level-3", "confidence": 0.9, "source": "LLM",
                "material": {"name": "concrete"}
            },
            {
                "id": "elem-slab-001", "type": "SLAB", "name": "Ground Slab",
                "placement": {"origin": {"x": 5, "y": 5, "z": 0}},
                "geometry": {
                    "method": "EXTRUSION",
                    "profile": {"type": "RECTANGLE", "width": 10, "height": 10},
                    "direction": {"x": 0, "y": 0, "z": 1},
                    "depth": 0.3
                },
                "container": "level-1", "confidence": 0.85, "source": "LLM",
                "material": {"name": "concrete_floor"}
            },
            {
                "id": "elem-col-001", "type": "COLUMN", "name": "Column GF",
                "placement": {"origin": {"x": 0, "y": 0, "z": 0}},
                "geometry": {
                    "method": "EXTRUSION",
                    "profile": {"type": "CIRCLE", "radius": 0.25},
                    "direction": {"x": 0, "y": 0, "z": 1},
                    "depth": 3.5
                },
                "container": "level-1", "confidence": 0.8, "source": "LLM",
                "material": {"name": "steel"}
            },
            {
                "id": "elem-space-001", "type": "SPACE", "name": "Office Room",
                "placement": {"origin": {"x": 1, "y": 1, "z": 0}},
                "geometry": {
                    "method": "EXTRUSION",
                    "profile": {"type": "RECTANGLE", "width": 8, "height": 8},
                    "direction": {"x": 0, "y": 0, "z": 1},
                    "depth": 3.0
                },
                "container": "level-1", "confidence": 0.7, "source": "LLM",
                "properties": {"usage": "OFFICE"}
            }
        ],
        "metadata": {
            "outputMode": "FULL_SEMANTIC",
            "validationStatus": "PASSED",
            "placementZIsAbsolute": True
        }
    }


# ============================================================================
# TESTS
# ============================================================================

def test_normalize_vector():
    """Unit test for normalize_vector helper."""
    # Standard normalization
    result = normalize_vector(3, 0, 0)
    assert abs(result[0] - 1.0) < 1e-9 and abs(result[1]) < 1e-9 and abs(result[2]) < 1e-9, \
        f"Expected (1,0,0), got {result}"

    # Zero-length → fallback
    result = normalize_vector(0, 0, 0)
    assert result == (0, 0, 1), f"Expected fallback (0,0,1), got {result}"

    # Custom fallback
    result = normalize_vector(0, 0, 0, fallback=(0, 1, 0))
    assert result == (0, 1, 0), f"Expected fallback (0,1,0), got {result}"

    # NaN → fallback
    result = normalize_vector(float('nan'), 1, 0)
    assert result == (0, 0, 1), f"Expected fallback on NaN, got {result}"

    # inf → fallback
    result = normalize_vector(float('inf'), 0, 0)
    assert result == (0, 0, 1), f"Expected fallback on inf, got {result}"

    # Already unit vector
    result = normalize_vector(0, 0, 1)
    assert abs(result[2] - 1.0) < 1e-9, f"Expected (0,0,1), got {result}"

    print("  PASS: test_normalize_vector")


def test_sanitize_axis_ref():
    """Unit test for sanitize_axis_ref helper."""
    # Parallel axis and ref should get fixed
    ax, rf = sanitize_axis_ref(
        {'x': 0, 'y': 0, 'z': 1},
        {'x': 0, 'y': 0, 'z': 1}
    )
    dot = ax[0] * rf[0] + ax[1] * rf[1] + ax[2] * rf[2]
    assert abs(dot) < 0.01, f"Axis and ref still parallel: dot={dot}"

    # Zero-length vectors should get fixed
    ax, rf = sanitize_axis_ref(
        {'x': 0, 'y': 0, 'z': 0},
        {'x': 0, 'y': 0, 'z': 0}
    )
    ax_len = math.sqrt(sum(c**2 for c in ax))
    rf_len = math.sqrt(sum(c**2 for c in rf))
    assert ax_len > 0.99, f"Axis zero-length: {ax}"
    assert rf_len > 0.99, f"Ref zero-length: {rf}"

    # Normal case should pass through
    ax, rf = sanitize_axis_ref(
        {'x': 0, 'y': 0, 'z': 1},
        {'x': 1, 'y': 0, 'z': 0}
    )
    assert abs(ax[2] - 1.0) < 1e-6 and abs(rf[0] - 1.0) < 1e-6, \
        f"Standard basis should pass through: ax={ax}, rf={rf}"

    # Right-handed check: cross(axis, ref) should be non-zero
    cross = (
        ax[1] * rf[2] - ax[2] * rf[1],
        ax[2] * rf[0] - ax[0] * rf[2],
        ax[0] * rf[1] - ax[1] * rf[0]
    )
    cross_len = math.sqrt(sum(c**2 for c in cross))
    assert cross_len > 0.99, f"Cross product degenerate: {cross_len}"

    print("  PASS: test_sanitize_axis_ref")


def test_3storey_elevations():
    """Test that 3-storey building produces correct elevations [0.0, 3.5, 7.0]."""
    css = make_3storey_css()
    ifc_content, elem_count, error_count = generate_ifc4_from_css(css)

    with open('/tmp/test_3storey.ifc', 'w') as f:
        f.write(ifc_content)

    import ifcopenshell
    ifc_file = ifcopenshell.open('/tmp/test_3storey.ifc')

    storeys = ifc_file.by_type('IfcBuildingStorey')
    elevations = sorted([s.Elevation for s in storeys])
    assert elevations == [0.0, 3.5, 7.0], \
        f"Expected [0.0, 3.5, 7.0], got {elevations}"
    assert error_count == 0, f"Expected 0 errors, got {error_count}"
    assert elem_count == 6, f"Expected 6 elements, got {elem_count}"

    print("  PASS: test_3storey_elevations")


def test_walls_are_ifc_wall():
    """Test that walls use IfcWall, not IfcWallStandardCase."""
    css = make_3storey_css()
    ifc_content, _, _ = generate_ifc4_from_css(css)

    with open('/tmp/test_walls.ifc', 'w') as f:
        f.write(ifc_content)

    import ifcopenshell
    ifc_file = ifcopenshell.open('/tmp/test_walls.ifc')

    standard_cases = ifc_file.by_type('IfcWallStandardCase')
    assert len(standard_cases) == 0, \
        f"Found {len(standard_cases)} IfcWallStandardCase, expected 0"

    walls = ifc_file.by_type('IfcWall')
    assert len(walls) >= 3, f"Expected >= 3 IfcWall, got {len(walls)}"

    print("  PASS: test_walls_are_ifc_wall")


def test_no_spatial_container_representation_warnings():
    """Test that spatial containers (Site, Building, Storeys) don't trigger
    'missing Representation' warnings."""
    css = make_3storey_css()
    ifc_content, _, _ = generate_ifc4_from_css(css)

    with open('/tmp/test_spatial.ifc', 'w') as f:
        f.write(ifc_content)

    import ifcopenshell
    ifc_file = ifcopenshell.open('/tmp/test_spatial.ifc')

    # Spatial containers should NOT be counted as missing representation
    spatial_types = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey'}
    products = ifc_file.by_type('IfcProduct')
    non_spatial = [p for p in products if p.is_a() not in spatial_types]
    missing_rep = [p for p in non_spatial if not p.Representation]
    assert len(missing_rep) == 0, \
        f"{len(missing_rep)} non-spatial products missing Representation: " \
        f"{[p.is_a() for p in missing_rep]}"

    # Spatial containers ARE expected to not have representation
    spatial = [p for p in products if p.is_a() in spatial_types]
    assert len(spatial) == 5, \
        f"Expected 5 spatial containers (1 Site + 1 Building + 3 Storeys), got {len(spatial)}"

    print("  PASS: test_no_spatial_container_representation_warnings")


def test_no_invalid_direction_vectors():
    """Test that no direction vector in the IFC is zero-length,
    including when given degenerate input."""
    css = make_3storey_css()
    # Add an element with all-zero directions to verify sanitization
    css['elements'].append({
        "id": "elem-degen-001", "type": "PROXY", "name": "Degenerate Directions",
        "placement": {
            "origin": {"x": 5, "y": 5, "z": 0},
            "axis": {"x": 0, "y": 0, "z": 0},
            "refDirection": {"x": 0, "y": 0, "z": 0}
        },
        "geometry": {
            "method": "EXTRUSION",
            "profile": {"type": "RECTANGLE", "width": 1, "height": 1},
            "direction": {"x": 0, "y": 0, "z": 0},
            "depth": 1
        },
        "container": "level-1", "confidence": 0.3, "source": "LLM"
    })

    ifc_content, _, _ = generate_ifc4_from_css(css)

    with open('/tmp/test_directions.ifc', 'w') as f:
        f.write(ifc_content)

    import ifcopenshell
    ifc_file = ifcopenshell.open('/tmp/test_directions.ifc')

    # Check every IfcDirection in the file
    for direction in ifc_file.by_type('IfcDirection'):
        ratios = direction.DirectionRatios
        length = math.sqrt(sum(float(r)**2 for r in ratios))
        assert length > 1e-6, f"Zero-length direction found: {ratios}"

    # Check no parallel axis/refDirection in placements
    for lp in ifc_file.by_type('IfcLocalPlacement'):
        rp = lp.RelativePlacement
        if rp and hasattr(rp, 'Axis') and rp.Axis and hasattr(rp, 'RefDirection') and rp.RefDirection:
            ar = rp.Axis.DirectionRatios
            rr = rp.RefDirection.DirectionRatios
            dot = sum(float(a) * float(r) for a, r in zip(ar, rr))
            assert abs(dot) < 0.01, \
                f"Parallel axis/ref in placement: dot={dot}, axis={ar}, ref={rr}"

    print("  PASS: test_no_invalid_direction_vectors")


def test_placement_chain():
    """Test that Building → Site → Project placement chain is correct."""
    css = make_3storey_css()
    ifc_content, _, _ = generate_ifc4_from_css(css)

    with open('/tmp/test_chain.ifc', 'w') as f:
        f.write(ifc_content)

    import ifcopenshell
    ifc_file = ifcopenshell.open('/tmp/test_chain.ifc')

    building = ifc_file.by_type('IfcBuilding')[0]
    site = ifc_file.by_type('IfcSite')[0]

    # Building placement should be relative to Site's ObjectPlacement
    bld_placement = building.ObjectPlacement
    site_placement = site.ObjectPlacement
    assert bld_placement.PlacementRelTo == site_placement, \
        "Building placement should be relative to Site placement"

    # Site placement should be relative to Project placement (PlacementRelTo=None at root)
    assert site_placement.PlacementRelTo is None, \
        "Site's parent should be the root (Project) placement"

    # Storeys should be relative to Building placement
    for storey in ifc_file.by_type('IfcBuildingStorey'):
        assert storey.ObjectPlacement.PlacementRelTo == bld_placement, \
            f"Storey '{storey.Name}' should be relative to Building placement"

    print("  PASS: test_placement_chain")


def test_per_element_proxy_fallback():
    """Test that a single element with unrecoverable geometry becomes a proxy
    but does NOT cause the entire model to go PROXY_ONLY."""
    css = make_3storey_css()
    css['metadata']['outputMode'] = 'FULL_SEMANTIC'

    # Add an element that will fail entity creation by using an invalid entity type
    # We simulate this by adding an element that tries to use EQUIPMENT with an
    # unrecognized semanticType — it should fallback to proxy individually
    css['elements'].append({
        "id": "elem-equip-bad", "type": "EQUIPMENT", "name": "Unknown Device",
        "semanticType": "IfcNonExistentType",
        "placement": {"origin": {"x": 8, "y": 8, "z": 0}},
        "geometry": {
            "method": "EXTRUSION",
            "profile": {"type": "RECTANGLE", "width": 1, "height": 1},
            "direction": {"x": 0, "y": 0, "z": 1},
            "depth": 2
        },
        "container": "level-1", "confidence": 0.95, "source": "LLM"
    })

    ifc_content, elem_count, error_count = generate_ifc4_from_css(css)

    with open('/tmp/test_proxy_fallback.ifc', 'w') as f:
        f.write(ifc_content)

    import ifcopenshell
    ifc_file = ifcopenshell.open('/tmp/test_proxy_fallback.ifc')

    # The walls should still be IfcWall (not proxy)
    walls = ifc_file.by_type('IfcWall')
    assert len(walls) >= 3, \
        f"Expected >= 3 IfcWall (not proxied), got {len(walls)}"

    # The columns should still be IfcColumn
    columns = ifc_file.by_type('IfcColumn')
    assert len(columns) >= 1, \
        f"Expected >= 1 IfcColumn (not proxied), got {len(columns)}"

    # The equipment should be a proxy (since EQUIPMENT maps to proxy anyway)
    proxies = ifc_file.by_type('IfcBuildingElementProxy')
    assert len(proxies) >= 1, \
        f"Expected >= 1 IfcBuildingElementProxy, got {len(proxies)}"

    # Total element count should include all elements (no global fallback)
    assert elem_count == 7, \
        f"Expected 7 elements (6 original + 1 equipment), got {elem_count}"

    print("  PASS: test_per_element_proxy_fallback")


# ============================================================================
# TEST RUNNER
# ============================================================================

if __name__ == '__main__':
    print("\nIFC4 CSS v1.0 Generator - Regression Tests")
    print("=" * 55)

    tests = [
        test_normalize_vector,
        test_sanitize_axis_ref,
        test_3storey_elevations,
        test_walls_are_ifc_wall,
        test_no_spatial_container_representation_warnings,
        test_no_invalid_direction_vectors,
        test_placement_chain,
        test_per_element_proxy_fallback,
    ]

    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            passed += 1
        except Exception as e:
            print(f"  FAIL: {test_fn.__name__}: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

    print(f"\n{'=' * 55}")
    print(f"Results: {passed} passed, {failed} failed out of {len(tests)}")

    if failed == 0:
        print("ALL TESTS PASSED")
    else:
        print("SOME TESTS FAILED")

    sys.exit(0 if failed == 0 else 1)
