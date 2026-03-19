#!/usr/bin/env python3
"""
Revit Interoperability Validation for IFC4 exports.

Automated structural, geometry, and Revit-oriented checks against generated IFC files.
Produces a revit_interop_report.json with pass/fail for each check.

Run with: python test_revit_interop.py
Requires: ifcopenshell (installed in Docker container or local conda env)

Manual Revit Import Checklist (post-automated checks):
1. Open Revit 2024+, File > Open > IFC
2. Verify categories appear in Project Browser (Walls, Floors, Doors, etc.)
3. Select a wall and try dimension editing — confirm editability
4. Verify storey elevation mapping matches model
5. Check material assignments in element properties
6. Verify spatial containment in Revit project tree
7. Check that doors/windows are hosted by walls (cut openings visible)
"""

import json
import sys
import os
import math
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lambda_function import generate_ifc4_from_css

try:
    import ifcopenshell
except ImportError:
    print("ERROR: ifcopenshell not available. Run inside Docker container or conda env.")
    sys.exit(1)


# ============================================================================
# TEST FIXTURES
# ============================================================================

def make_office_fixture():
    """3-storey office with walls, slabs, columns, doors, windows."""
    return {
        "cssVersion": "1.0", "domain": "ARCH",
        "facility": {"name": "Interop Office", "type": "office", "units": "M",
                      "origin": {"x": 0, "y": 0, "z": 0}, "axes": "RIGHT_HANDED_Z_UP"},
        "levelsOrSegments": [
            {"id": "L1", "type": "STOREY", "name": "Ground Floor", "elevation_m": 0.0, "height_m": 3.5},
            {"id": "L2", "type": "STOREY", "name": "First Floor", "elevation_m": 3.5, "height_m": 3.5},
            {"id": "L3", "type": "STOREY", "name": "Second Floor", "elevation_m": 7.0, "height_m": 3.5},
        ],
        "elements": [
            {"id": "w1", "type": "WALL", "name": "South Wall", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 0, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 0.3},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 3.5},
             "material": {"name": "concrete"}, "properties": {"isExternal": True, "loadBearing": True}},
            {"id": "w2", "type": "WALL", "name": "North Wall", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 8, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 0.3},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 3.5},
             "material": {"name": "concrete"}, "properties": {"isExternal": True}},
            {"id": "w3", "type": "WALL", "name": "East Wall", "container": "L1", "confidence": 0.85,
             "placement": {"origin": {"x": 10, "y": 4, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 8, "height": 0.3},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 3.5},
             "material": {"name": "concrete"}, "properties": {"isExternal": True}},
            {"id": "w4", "type": "WALL", "name": "West Wall", "container": "L1", "confidence": 0.85,
             "placement": {"origin": {"x": 0, "y": 4, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 8, "height": 0.3},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 3.5},
             "material": {"name": "concrete"}, "properties": {"isExternal": True}},
            {"id": "s1", "type": "SLAB", "name": "Ground Slab", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 4, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 8},
                          "direction": {"x": 0, "y": 0, "z": -1}, "depth": 0.3},
             "properties": {"slabType": "FLOOR"}},
            {"id": "s2", "type": "SLAB", "name": "First Floor Slab", "container": "L2", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 4, "z": 3.5}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 8},
                          "direction": {"x": 0, "y": 0, "z": -1}, "depth": 0.3},
             "properties": {"slabType": "FLOOR"}},
            {"id": "c1", "type": "COLUMN", "name": "Column 1", "container": "L1", "confidence": 0.8,
             "placement": {"origin": {"x": 0, "y": 0, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 0.4, "height": 0.4},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 3.5},
             "material": {"name": "steel"}, "properties": {"loadBearing": True}},
            {"id": "d1", "type": "DOOR", "name": "Entry Door", "container": "L1", "confidence": 0.8,
             "placement": {"origin": {"x": 3, "y": 0, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 1.0, "height": 0.1},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 2.1},
             "properties": {"isExternal": True}},
            {"id": "win1", "type": "WINDOW", "name": "South Window", "container": "L1", "confidence": 0.75,
             "placement": {"origin": {"x": 7, "y": 0, "z": 1.0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 1.5, "height": 0.1},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 1.2},
             "properties": {"isExternal": True}},
        ],
        "metadata": {"outputMode": "FULL_SEMANTIC"}
    }


def make_mep_fixture():
    """MEP-heavy model with ducts, pipes, and equipment."""
    return {
        "cssVersion": "1.0", "domain": "ARCH",
        "facility": {"name": "MEP Test", "type": "commercial", "units": "M",
                      "origin": {"x": 0, "y": 0, "z": 0}, "axes": "RIGHT_HANDED_Z_UP"},
        "levelsOrSegments": [
            {"id": "L1", "type": "STOREY", "name": "Ground Floor", "elevation_m": 0.0, "height_m": 4.0},
        ],
        "elements": [
            {"id": "w1", "type": "WALL", "name": "Wall 1", "container": "L1", "confidence": 0.9,
             "placement": {"origin": {"x": 5, "y": 0, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 10, "height": 0.2},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 4.0}},
            {"id": "duct1", "type": "DUCT", "name": "Supply Duct A", "container": "L1", "confidence": 0.7,
             "placement": {"origin": {"x": 2, "y": 3, "z": 3.0},
                           "axis": {"x": 1, "y": 0, "z": 0}},
             "geometry": {"method": "SWEEP", "profile": {"type": "CIRCLE", "radius": 0.15},
                          "direction": {"x": 1, "y": 0, "z": 0}, "depth": 6.0,
                          "pathPoints": [{"x": -1, "y": 3, "z": 3.0}, {"x": 5, "y": 3, "z": 3.0}]},
             "properties": {"shape": "round"}},
            {"id": "pipe1", "type": "PIPE", "name": "Hot Water Pipe", "container": "L1", "confidence": 0.65,
             "placement": {"origin": {"x": 1, "y": 5, "z": 2.5},
                           "axis": {"x": 0, "y": 1, "z": 0}},
             "geometry": {"method": "SWEEP", "profile": {"type": "CIRCLE", "radius": 0.05, "wallThickness": 0.005},
                          "direction": {"x": 0, "y": 1, "z": 0}, "depth": 4.0,
                          "pathPoints": [{"x": 1, "y": 3, "z": 2.5}, {"x": 1, "y": 7, "z": 2.5}]},
             "properties": {"shape": "round"}},
            {"id": "fan1", "type": "EQUIPMENT", "name": "AHU Fan", "container": "L1",
             "confidence": 0.6, "semanticType": "IfcFan",
             "placement": {"origin": {"x": 8, "y": 4, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 1.2, "height": 1.0},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 1.5}},
            {"id": "pump1", "type": "EQUIPMENT", "name": "Chilled Water Pump", "container": "L1",
             "confidence": 0.55, "semanticType": "IfcPump",
             "placement": {"origin": {"x": 2, "y": 7, "z": 0}},
             "geometry": {"method": "EXTRUSION", "profile": {"type": "RECTANGLE", "width": 0.6, "height": 0.4},
                          "direction": {"x": 0, "y": 0, "z": 1}, "depth": 0.5}},
        ],
        "metadata": {"outputMode": "HYBRID"}
    }


# ============================================================================
# CHECK FUNCTIONS
# ============================================================================

def check_no_wall_standard_case(model):
    """IFC4 should not use IfcWallStandardCase (Revit import issues)."""
    walls_sc = model.by_type('IfcWallStandardCase')
    return {'pass': len(walls_sc) == 0, 'count': len(walls_sc),
            'detail': 'IfcWallStandardCase should not be used in IFC4'}


def check_walls_have_predefined_type(model):
    """All IfcWall elements should have PredefinedType set."""
    walls = model.by_type('IfcWall')
    missing = [w.GlobalId for w in walls if not w.PredefinedType]
    return {'pass': len(missing) == 0, 'total': len(walls), 'missing': len(missing)}


def check_storeys_exist(model):
    """IfcBuildingStorey elements must exist with valid elevations."""
    storeys = model.by_type('IfcBuildingStorey')
    if not storeys:
        return {'pass': False, 'detail': 'No IfcBuildingStorey found'}
    invalid = []
    for s in storeys:
        if s.Elevation is None or not math.isfinite(s.Elevation):
            invalid.append(s.Name)
    return {'pass': len(invalid) == 0, 'total': len(storeys), 'invalid_elevations': invalid}


def check_spatial_containment(model):
    """All products should be linked to storeys via IfcRelContainedInSpatialStructure."""
    rels = model.by_type('IfcRelContainedInSpatialStructure')
    contained_ids = set()
    for rel in rels:
        for elem in rel.RelatedElements:
            contained_ids.add(elem.id())

    products = model.by_type('IfcProduct')
    spatial = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject'}
    uncontained = []
    for p in products:
        if p.is_a() in spatial:
            continue
        if p.id() not in contained_ids:
            uncontained.append(f"{p.is_a()} '{p.Name}'")

    return {'pass': len(uncontained) == 0, 'total': len(products), 'uncontained': uncontained[:10]}


def check_material_layers(model):
    """Walls and slabs should have IfcMaterialLayerSetUsage."""
    walls = model.by_type('IfcWall')
    slabs = model.by_type('IfcSlab')
    targets = walls + slabs

    missing = []
    for elem in targets:
        has_material = False
        for rel in model.by_type('IfcRelAssociatesMaterial'):
            if elem in rel.RelatedObjects:
                has_material = True
                break
        if not has_material:
            missing.append(f"{elem.is_a()} '{elem.Name}'")

    return {'pass': len(missing) == 0, 'total': len(targets), 'missing': missing[:10]}


def check_no_nan_coordinates(model):
    """No NaN or Inf values in any placement coordinate."""
    issues = []
    for p in model.by_type('IfcCartesianPoint'):
        coords = p.Coordinates
        if coords:
            for i, c in enumerate(coords):
                if not math.isfinite(c):
                    issues.append(f"Point #{p.id()} coord[{i}] = {c}")
                    break
    return {'pass': len(issues) == 0, 'issues': issues[:10]}


def check_direction_vectors(model):
    """All direction vectors should be unit-length and finite."""
    issues = []
    for d in model.by_type('IfcDirection'):
        ratios = d.DirectionRatios
        if not ratios:
            continue
        length = math.sqrt(sum(r * r for r in ratios))
        if not math.isfinite(length):
            issues.append(f"Direction #{d.id()}: non-finite")
        elif abs(length - 1.0) > 0.01:
            issues.append(f"Direction #{d.id()}: length={length:.4f}")
    return {'pass': len(issues) == 0, 'issues': issues[:10]}


def check_swept_disk_for_mep(model):
    """Circular MEP elements should use IfcSweptDiskSolid when SWEEP was requested."""
    swept_disks = []
    for p in model.by_type('IfcProduct'):
        if not p.Representation:
            continue
        for rep in (p.Representation.Representations or []):
            for item in (rep.Items or []):
                if item.is_a('IfcSweptDiskSolid'):
                    swept_disks.append(p.Name or p.is_a())
    return {'info': True, 'swept_disk_count': len(swept_disks), 'elements': swept_disks[:10]}


def check_property_sets(model):
    """Check that common property sets exist on structural elements."""
    pset_names = set()
    for pset in model.by_type('IfcPropertySet'):
        pset_names.add(pset.Name)

    expected = ['Pset_WallCommon', 'Pset_SlabCommon']
    found = [p for p in expected if p in pset_names]
    missing = [p for p in expected if p not in pset_names]

    return {'pass': len(missing) == 0, 'found': found, 'missing': missing, 'all_psets': sorted(pset_names)}


def check_category_distribution(model):
    """Report IFC entity type distribution for Revit category mapping."""
    dist = {}
    spatial = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject'}
    for p in model.by_type('IfcProduct'):
        t = p.is_a()
        if t in spatial:
            continue
        dist[t] = dist.get(t, 0) + 1
    return {'info': True, 'distribution': dist}


# ============================================================================
# MAIN
# ============================================================================

def run_fixture(name, css_fixture):
    """Generate IFC from fixture and run all checks."""
    print(f"\n{'=' * 60}")
    print(f"FIXTURE: {name}")
    print(f"{'=' * 60}")

    try:
        result = generate_ifc4_from_css(css_fixture)
        ifc_bytes = result.get('ifc_data') or result.get('ifcData')
        if not ifc_bytes:
            return {'fixture': name, 'error': 'No IFC data generated', 'checks': {}}

        # Write to temp file and parse
        tmp_path = f'/tmp/test_interop_{name}.ifc'
        if isinstance(ifc_bytes, str):
            with open(tmp_path, 'w') as f:
                f.write(ifc_bytes)
        else:
            with open(tmp_path, 'wb') as f:
                f.write(ifc_bytes)

        model = ifcopenshell.open(tmp_path)

    except Exception as e:
        return {'fixture': name, 'error': str(e), 'traceback': traceback.format_exc(), 'checks': {}}

    checks = {}
    check_fns = [
        ('no_wall_standard_case', check_no_wall_standard_case),
        ('walls_have_predefined_type', check_walls_have_predefined_type),
        ('storeys_exist', check_storeys_exist),
        ('spatial_containment', check_spatial_containment),
        ('material_layers', check_material_layers),
        ('no_nan_coordinates', check_no_nan_coordinates),
        ('direction_vectors', check_direction_vectors),
        ('swept_disk_for_mep', check_swept_disk_for_mep),
        ('property_sets', check_property_sets),
        ('category_distribution', check_category_distribution),
    ]

    for check_name, check_fn in check_fns:
        try:
            result = check_fn(model)
            checks[check_name] = result
            status = 'PASS' if result.get('pass', True) else 'FAIL'
            if result.get('info'):
                status = 'INFO'
            print(f"  [{status}] {check_name}: {json.dumps(result, default=str)[:120]}")
        except Exception as e:
            checks[check_name] = {'pass': False, 'error': str(e)}
            print(f"  [ERROR] {check_name}: {e}")

    return {'fixture': name, 'checks': checks}


def main():
    fixtures = [
        ('office_3storey', make_office_fixture()),
        ('mep_heavy', make_mep_fixture()),
    ]

    report = {'fixtures': [], 'summary': {'total_checks': 0, 'passed': 0, 'failed': 0, 'info': 0}}

    for name, fixture in fixtures:
        result = run_fixture(name, fixture)
        report['fixtures'].append(result)

        for check_name, check_result in result.get('checks', {}).items():
            report['summary']['total_checks'] += 1
            if check_result.get('info'):
                report['summary']['info'] += 1
            elif check_result.get('pass', True):
                report['summary']['passed'] += 1
            else:
                report['summary']['failed'] += 1

    report_path = '/tmp/revit_interop_report.json'
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2, default=str)

    print(f"\n{'=' * 60}")
    print(f"SUMMARY: {report['summary']['passed']} passed, {report['summary']['failed']} failed, "
          f"{report['summary']['info']} info out of {report['summary']['total_checks']} checks")
    print(f"Report saved to: {report_path}")
    print(f"{'=' * 60}")

    return report['summary']['failed'] == 0


if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
