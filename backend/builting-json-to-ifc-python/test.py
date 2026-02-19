import sys
sys.path.insert(0, '/var/task')

from lambda_function import handler

test_event = {
    "buildingSpec": {
        "buildingName": "Test Building",
        "dimensions": {
            "length_m": 100,
            "width_m": 50,
            "height_m": 6
        },
        "elevations": {
            "portal_west_m": 0
        }
    },
    "renderId": "test-123",
    "userId": "test-user"
}

result = handler(test_event, None)
ifc_content = result['ifcContent']

print("\n✅ SUCCESS! IFC Generated")
print(f"IFC Content Length: {len(ifc_content)} bytes")

# Check for entity types
import re
entities = set(re.findall(r'IFC[A-Z_]+', ifc_content))
print(f"\nEntity types found: {sorted(entities)}")

# Check for specific elements
if 'IFCBEAM' in ifc_content:
    print("✓ IFCBEAM entity found!")
elif 'IFCSLAB' in ifc_content:
    print("✗ IFCSLAB found (expected IFCBEAM)")
else:
    print("✗ Neither IFCBEAM nor IFCSLAB found")

print("\nFirst 300 chars:")
print(ifc_content[:300])
print("\nLast 200 chars:")
print(ifc_content[-200:])
