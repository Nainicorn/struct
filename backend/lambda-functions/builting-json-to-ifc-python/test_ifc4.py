#!/usr/bin/env python3
"""
Local test script for the IFC4 generator without AWS Lambda runtime.
Tests with sample building specs.
"""

import json
import sys
sys.path.insert(0, '/opt/conda/envs/ifc/lib/python3.11/site-packages' if '/opt/conda' in sys.executable else '.')

# Import the lambda function module
from lambda_function import generate_ifc4


def test_generic_office():
    """Test with a generic office building."""
    print("\n" + "="*60)
    print("TEST 1: Generic Office Building")
    print("="*60)

    spec = {
        "buildingName": "Downtown Office Complex",
        "buildingType": "OFFICE",
        "dimensions": {
            "length_m": 60.0,
            "width_m": 40.0,
            "height_m": 15.0,
            "wall_thickness_m": 0.3
        },
        "elevations": {
            "floor_level_m": 0.0
        },
        "rooms": [
            {
                "name": "Conference Room A",
                "usage": "OFFICE",
                "length_m": 12.0,
                "width_m": 8.0,
                "height_m": 3.0,
                "x_position_m": 5.0,
                "y_position_m": 5.0
            },
            {
                "name": "Mechanical Room",
                "usage": "MECHANICAL",
                "length_m": 8.0,
                "width_m": 6.0,
                "height_m": 3.0,
                "x_position_m": 50.0,
                "y_position_m": 30.0
            },
            {
                "name": "Storage",
                "usage": "STORAGE",
                "length_m": 6.0,
                "width_m": 4.0,
                "height_m": 3.0,
                "x_position_m": 30.0,
                "y_position_m": 30.0
            }
        ],
        "ventilation": {
            "system_type": "mechanical",
            "intake_location": "West",
            "exhaust_location": "East",
            "num_fans": 2
        },
        "equipment": [
            {
                "name": "AHU-01",
                "type": "AHU",
                "x_position_m": 52.0,
                "y_position_m": 32.0
            },
            {
                "name": "Boiler-01",
                "type": "BOILER",
                "x_position_m": 52.0,
                "y_position_m": 35.0
            }
        ],
        "materials": {
            "walls": "concrete",
            "floor": "concrete",
            "roof": "metal"
        },
        "structural_system": "FRAME"
    }

    try:
        ifc_content = generate_ifc4(spec)
        lines = ifc_content.count('\n')
        print(f"✓ IFC4 generated successfully")
        print(f"  File size: {len(ifc_content)} bytes")
        print(f"  Number of lines: {lines}")

        # Write to file
        with open('/tmp/test_office.ifc', 'w') as f:
            f.write(ifc_content)
        print(f"  Saved to: /tmp/test_office.ifc")

        return True
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_tunnel():
    """Test with a tunnel structure."""
    print("\n" + "="*60)
    print("TEST 2: Tunnel Structure")
    print("="*60)

    spec = {
        "buildingName": "Highway Tunnel - Section A",
        "buildingType": "TUNNEL",
        "dimensions": {
            "length_m": 500.0,
            "width_m": 12.0,
            "height_m": 8.0,
            "wall_thickness_m": 0.5
        },
        "elevations": {
            "floor_level_m": 50.0
        },
        "rooms": [
            {
                "name": "Tunnel Bore",
                "usage": "CIRCULATION",
                "length_m": 500.0,
                "width_m": 12.0,
                "height_m": 7.0,
                "x_position_m": 0.0,
                "y_position_m": 0.0
            }
        ],
        "ventilation": {
            "system_type": "mechanical",
            "intake_location": "West",
            "exhaust_location": "East",
            "num_fans": 1
        },
        "equipment": [
            {
                "name": "Emergency Generator",
                "type": "GENERATOR",
                "x_position_m": 250.0,
                "y_position_m": 6.0
            }
        ],
        "materials": {
            "walls": "concrete",
            "floor": "concrete",
            "roof": "concrete"
        },
        "structural_system": "LOADBEARING"
    }

    try:
        ifc_content = generate_ifc4(spec)
        lines = ifc_content.count('\n')
        print(f"✓ IFC4 generated successfully")
        print(f"  File size: {len(ifc_content)} bytes")
        print(f"  Number of lines: {lines}")

        # Write to file
        with open('/tmp/test_tunnel.ifc', 'w') as f:
            f.write(ifc_content)
        print(f"  Saved to: /tmp/test_tunnel.ifc")

        return True
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_warehouse():
    """Test with a warehouse structure."""
    print("\n" + "="*60)
    print("TEST 3: Warehouse")
    print("="*60)

    spec = {
        "buildingName": "Distribution Warehouse",
        "buildingType": "WAREHOUSE",
        "dimensions": {
            "length_m": 120.0,
            "width_m": 80.0,
            "height_m": 12.0,
            "wall_thickness_m": 0.3
        },
        "elevations": {
            "floor_level_m": 0.0
        },
        "rooms": [
            {
                "name": "Main Storage",
                "usage": "STORAGE",
                "length_m": 120.0,
                "width_m": 80.0,
                "height_m": 11.0,
                "x_position_m": 0.0,
                "y_position_m": 0.0
            }
        ],
        "ventilation": {
            "system_type": "natural",
            "intake_location": "West",
            "exhaust_location": "East",
            "num_fans": 1
        },
        "equipment": [
            {
                "name": "Forklift Charger",
                "type": "BATTERY",
                "x_position_m": 10.0,
                "y_position_m": 10.0
            }
        ],
        "materials": {
            "walls": "steel",
            "floor": "concrete",
            "roof": "metal"
        },
        "structural_system": "FRAME"
    }

    try:
        ifc_content = generate_ifc4(spec)
        lines = ifc_content.count('\n')
        print(f"✓ IFC4 generated successfully")
        print(f"  File size: {len(ifc_content)} bytes")
        print(f"  Number of lines: {lines}")

        # Write to file
        with open('/tmp/test_warehouse.ifc', 'w') as f:
            f.write(ifc_content)
        print(f"  Saved to: /tmp/test_warehouse.ifc")

        return True
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    print("\n🧪 IFC4 Generator Test Suite")
    print("Testing universal building type support\n")

    results = []
    results.append(("Generic Office", test_generic_office()))
    results.append(("Tunnel", test_tunnel()))
    results.append(("Warehouse", test_warehouse()))

    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    for name, passed in results:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status}: {name}")

    all_passed = all(r[1] for r in results)
    print(f"\nOverall: {'✓ ALL TESTS PASSED' if all_passed else '✗ SOME TESTS FAILED'}")

    sys.exit(0 if all_passed else 1)
