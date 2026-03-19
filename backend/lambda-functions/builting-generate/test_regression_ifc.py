#!/usr/bin/env python3
"""
IFC Regression Test Suite.

Generates IFC from canonical test fixtures, extracts a structural fingerprint,
and compares against saved golden baselines. Reports additions, deletions,
and type changes.

Run with: python test_regression_ifc.py
Update baselines: python test_regression_ifc.py --update-baselines
Requires: ifcopenshell (installed in Docker container or local conda env)
"""

import json
import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASELINES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'baselines')

from lambda_function import generate_ifc4_from_css

try:
    import ifcopenshell
except ImportError:
    print("ERROR: ifcopenshell not available. Run inside Docker container or conda env.")
    sys.exit(1)


# ============================================================================
# TEST FIXTURES (same as test_revit_interop.py but imported for regression)
# ============================================================================

def make_office_fixture():
    """3-storey office building."""
    return {
        "cssVersion": "1.0", "domain": "ARCH",
        "facility": {"name": "Regression Office", "type": "office", "units": "M",
                      "origin": {"x": 0, "y": 0, "z": 0}, "axes": "RIGHT_HANDED_Z_UP"},
        "levelsOrSegments": [
            {"id": "L1", "type": "STOREY", "name": "Ground Floor", "elevation_m": 0.0, "height_m": 3.5},
            {"id": "L2", "type": "STOREY", "name": "First Floor", "elevation_m": 3.5, "height_m": 3.5},
        ],
        "elements": [
            {"id": "w1", "type": "WALL", "name": "South Wall", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 0, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 0.3},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 3.5},
             "material": {"name": "concrete"}, "properties": {"isExternal": True}},
            {"id": "w2", "type": "WALL", "name": "North Wall", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 8, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 0.3},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 3.5},
             "material": {"name": "concrete"}, "properties": {"isExternal": True}},
            {"id": "s1", "type": "SLAB", "name": "Ground Slab", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 4, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 8},
                          "direction": {"x": 0, "y": 0, "z": -1}, "depth": 0.3},
             "properties": {"slabType": "FLOOR"}},
            {"id": "d1", "type": "DOOR", "name": "Entry Door", "container": "L1", "confidence": 0.8,
             "placement": {"origin": {"x": 3, "y": 0, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 1.0, "height": 0.1},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 2.1}},
        ],
        "metadata": {"outputMode": "FULL_SEMANTIC"}
    }


def make_mep_fixture():
    """MEP model with ducts and equipment."""
    return {
        "cssVersion": "1.0", "domain": "ARCH",
        "facility": {"name": "Regression MEP", "type": "commercial", "units": "M",
                      "origin": {"x": 0, "y": 0, "z": 0}, "axes": "RIGHT_HANDED_Z_UP"},
        "levelsOrSegments": [
            {"id": "L1", "type": "STOREY", "name": "Ground Floor", "elevation_m": 0.0, "height_m": 4.0},
        ],
        "elements": [
            {"id": "w1", "type": "WALL", "name": "Wall 1", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 0, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 0.2},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 4.0}},
            {"id": "duct1", "type": "DUCT", "name": "Supply Duct", "container": "L1", "confidence": 0.7,
             "placement": {"origin": {"x": 2, "y": 3, "z": 3.0}, "axis": {"x": 1, "y": 0, "z": 0}},
             "geometry": {"method": "SWEEP", "profile": {"type": "CIRCLE", "radius": 0.15},
                          "direction": {"x": 1, "y": 0, "z": 0}, "depth": 6.0,
                          "pathPoints": [{"x": -1, "y": 3, "z": 3.0}, {"x": 5, "y": 3, "z": 3.0}]},
             "properties": {"shape": "round"}},
            {"id": "fan1", "type": "EQUIPMENT", "name": "AHU Fan", "container": "L1",
             "confidence": 0.6, "semanticType": "IfcFan",
             "placement": {"origin": {"x": 8, "y": 4, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 1.2, "height": 1.0},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 1.5}},
        ],
        "metadata": {"outputMode": "HYBRID"}
    }


# ============================================================================
# FINGERPRINT EXTRACTION
# ============================================================================

def extract_fingerprint(model):
    """Extract sorted structural fingerprint: list of (entity_type, name, storey_name)."""
    spatial = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject'}

    # Build storey containment map
    storey_map = {}
    for rel in model.by_type('IfcRelContainedInSpatialStructure'):
        container = rel.RelatingStructure
        storey_name = container.Name if container else 'Unknown'
        for elem in rel.RelatedElements:
            storey_map[elem.id()] = storey_name

    fingerprint = []
    for p in model.by_type('IfcProduct'):
        if p.is_a() in spatial:
            continue
        entity_type = p.is_a()
        name = p.Name or 'Unnamed'
        storey = storey_map.get(p.id(), 'Uncontained')
        fingerprint.append((entity_type, name, storey))

    fingerprint.sort()
    return fingerprint


def compare_fingerprints(baseline, current):
    """Compare two fingerprints and return diff."""
    baseline_set = set(map(tuple, baseline))
    current_set = set(map(tuple, current))

    added = sorted(current_set - baseline_set)
    removed = sorted(baseline_set - current_set)

    # Detect type changes (same name+storey, different type)
    baseline_by_name = {(b[1], b[2]): b[0] for b in baseline}
    type_changes = []
    for c in current:
        key = (c[1], c[2])
        if key in baseline_by_name and baseline_by_name[key] != c[0]:
            type_changes.append({
                'name': c[1], 'storey': c[2],
                'was': baseline_by_name[key], 'now': c[0]
            })

    return {
        'match': len(added) == 0 and len(removed) == 0,
        'added': [{'type': a[0], 'name': a[1], 'storey': a[2]} for a in added],
        'removed': [{'type': r[0], 'name': r[1], 'storey': r[2]} for r in removed],
        'type_changes': type_changes,
        'baseline_count': len(baseline),
        'current_count': len(current)
    }


# ============================================================================
# MAIN
# ============================================================================

def run_regression(name, css_fixture, update_baselines=False):
    """Generate IFC, extract fingerprint, compare to baseline."""
    print(f"\n{'=' * 60}")
    print(f"REGRESSION: {name}")
    print(f"{'=' * 60}")

    baseline_path = os.path.join(BASELINES_DIR, f'{name}.json')

    try:
        result = generate_ifc4_from_css(css_fixture)
        ifc_bytes = result.get('ifc_data') or result.get('ifcData')
        if not ifc_bytes:
            print(f"  [ERROR] No IFC data generated")
            return False

        tmp_path = f'/tmp/test_regression_{name}.ifc'
        if isinstance(ifc_bytes, str):
            with open(tmp_path, 'w') as f:
                f.write(ifc_bytes)
        else:
            with open(tmp_path, 'wb') as f:
                f.write(ifc_bytes)

        model = ifcopenshell.open(tmp_path)
        fingerprint = extract_fingerprint(model)

        print(f"  Fingerprint: {len(fingerprint)} elements")
        for fp in fingerprint:
            print(f"    {fp[0]:30s} | {fp[1]:25s} | {fp[2]}")

    except Exception as e:
        print(f"  [ERROR] Generation failed: {e}")
        traceback.print_exc()
        return False

    if update_baselines:
        os.makedirs(BASELINES_DIR, exist_ok=True)
        with open(baseline_path, 'w') as f:
            json.dump(fingerprint, f, indent=2)
        print(f"  [UPDATED] Baseline saved to {baseline_path}")
        return True

    if not os.path.exists(baseline_path):
        print(f"  [SKIP] No baseline found at {baseline_path}")
        print(f"         Run with --update-baselines to create initial baselines")
        return True  # Not a failure, just no baseline yet

    with open(baseline_path) as f:
        baseline = json.load(f)

    diff = compare_fingerprints(baseline, fingerprint)

    if diff['match']:
        print(f"  [PASS] Fingerprint matches baseline ({diff['current_count']} elements)")
        return True
    else:
        print(f"  [FAIL] Fingerprint mismatch:")
        print(f"         Baseline: {diff['baseline_count']} elements")
        print(f"         Current:  {diff['current_count']} elements")
        if diff['added']:
            print(f"         Added ({len(diff['added'])}):")
            for a in diff['added']:
                print(f"           + {a['type']} '{a['name']}' @ {a['storey']}")
        if diff['removed']:
            print(f"         Removed ({len(diff['removed'])}):")
            for r in diff['removed']:
                print(f"           - {r['type']} '{r['name']}' @ {r['storey']}")
        if diff['type_changes']:
            print(f"         Type changes ({len(diff['type_changes'])}):")
            for tc in diff['type_changes']:
                print(f"           ~ '{tc['name']}' @ {tc['storey']}: {tc['was']} -> {tc['now']}")
        return False


def main():
    update = '--update-baselines' in sys.argv

    fixtures = [
        ('office_regression', make_office_fixture()),
        ('mep_regression', make_mep_fixture()),
    ]

    all_pass = True
    for name, fixture in fixtures:
        if not run_regression(name, fixture, update_baselines=update):
            all_pass = False

    print(f"\n{'=' * 60}")
    if update:
        print("Baselines updated successfully.")
    elif all_pass:
        print("ALL REGRESSION TESTS PASSED")
    else:
        print("SOME REGRESSION TESTS FAILED")
    print(f"{'=' * 60}")

    return all_pass


if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
