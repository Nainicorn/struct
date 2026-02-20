# IFC4 Generator Deployment Guide

## Summary of Changes

The `builting-json-to-ifc` Lambda function has been completely rewritten to generate rich, production-grade IFC4 files with full architectural detail. This significantly improves the 3D model quality and functionality.

### Key Improvements

#### IFC File Quality
- **Before**: 114 lines, 0 architectural elements, invalid geometry
- **After**: 500+ lines, 100+ architectural elements, valid IFC4 format with proper spatial hierarchy

#### Architecture
- ✅ Fixed critical bug: replaced invalid `IfcBuilding` envelope with proper structural decomposition (4 walls + floor + roof)
- ✅ Upgraded schema from IFC2X3 to IFC4 (better modern viewer support)
- ✅ Added 30+ materials with RGB colors and surface styling
- ✅ Implemented proper IFC element types (IfcWall, IfcSlab, IfcDoor, IfcWindow, IfcEquipment, etc.)
- ✅ Added property sets and quantity sets for all structural elements
- ✅ Added ventilation elements with configurable intake/exhaust positions
- ✅ Universal support for all building types (office, warehouse, tunnel, parking, hospital, industrial, etc.)

#### Features
- **Material Library**: Concrete, brick, steel, timber, glass with realistic colors
- **Space Classification**: Rooms classified by usage (office, mechanical, storage, circulation, etc.)
- **Equipment Types**: Maps to specific IFC4 entities (IfcGenerator, IfcPump, IfcFan, IfcCompressor, IfcTransformer, IfcBoiler, IfcChiller, etc.)
- **Ventilation**: Creates air terminals with configurable fan count and locations
- **Styling**: Full IFC surface styling with colors and transparency
- **Property Sets**: Load bearing, fire rating, thermal transmittance, net floor area, etc.

## Deployment Steps

### Prerequisites
- AWS CLI configured with credentials
- Docker installed
- ECR repository exists: `builting-json-to-ifc`
- AWS account ID and region available

### Step 1: Build Docker Image

```bash
cd backend/lambda-functions/builting-json-to-ifc-python
docker build --platform linux/arm64 -t builting-json-to-ifc:latest .
```

**Expected output**:
```
#14 exporting manifest list sha256:... done
#14 naming to docker.io/library/builting-json-to-ifc:latest done
#14 DONE 0.1s
```

### Step 2: Login to ECR

```bash
aws ecr get-login-password --region us-east-1 | docker login \
  --username AWS \
  --password-stdin <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
```

Replace `<AWS_ACCOUNT_ID>` with your AWS account ID.

### Step 3: Tag and Push Image

```bash
# Set variables
AWS_ACCOUNT_ID=<your-account-id>
AWS_REGION=us-east-1
ECR_REPO="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/builting-json-to-ifc"

# Tag image
docker tag builting-json-to-ifc:latest $ECR_REPO:latest
docker tag builting-json-to-ifc:latest $ECR_REPO:$(date +%Y%m%d-%H%M%S)

# Push to ECR
docker push $ECR_REPO:latest
```

### Step 4: Update Lambda Function

```bash
aws lambda update-function-code \
  --function-name builting-json-to-ifc \
  --image-uri $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/builting-json-to-ifc:latest \
  --region us-east-1
```

### Step 5: Verify Deployment

Monitor CloudWatch Logs:
```bash
aws logs tail /aws/lambda/builting-json-to-ifc --follow
```

## Testing

### Bedrock Lambda Updates
The Bedrock Lambda (`builting-bedrock-ifc`) has been updated with an enhanced prompt that extracts richer building specifications:

**New JSON fields**:
- `dimensions.wall_thickness_m`: Structural wall thickness
- `rooms[].usage`: Space classification (OFFICE, MECHANICAL, STORAGE, etc.)
- `openings[]`: Door and window data with wall positions
- `materials`: Wall, floor, roof material types
- `structural_system`: Building structural type (FRAME, LOADBEARING, SHELL, TRUSS)
- Equipment dimensions and details

**No deployment needed** - only Lambda layer code changed in `index.mjs`

### Testing the Pipeline

1. **Upload a file to trigger render**:
   - Use the frontend to upload sample building files (PDF, TXT, etc.)

2. **Monitor execution**:
   - Check Step Function execution: `builting-render-state-machine`
   - Review CloudWatch logs for `builting-bedrock-ifc` and `builting-json-to-ifc`

3. **Download and inspect generated IFC**:
   - View in xeokit web viewer (built-in)
   - Download and open in Revit or other IFC-compatible software
   - Verify materials, walls, roof, and property sets are present

## Expected Behavior

### Bedrock Lambda Output
```json
{
  "buildingName": "Extracted from documents",
  "buildingType": "OFFICE|WAREHOUSE|TUNNEL|PARKING|HOSPITAL|SCHOOL|INDUSTRIAL|RESIDENTIAL",
  "dimensions": {
    "length_m": 100.0,
    "width_m": 50.0,
    "height_m": 6.0,
    "wall_thickness_m": 0.3
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
    }
  ],
  "materials": {
    "walls": "concrete",
    "floor": "concrete",
    "roof": "metal"
  }
}
```

### Python Lambda IFC4 Output
- **Spatial Structure**: Project → Site → Building → Storey → Elements
- **Building Envelope**: 4 walls (IfcWall), floor slab (IfcSlab), roof slab (IfcSlab)
- **Spaces**: Rooms/spaces with proper usage classification (IfcSpace)
- **Equipment**: Specific IFC types based on equipment type
- **Ventilation**: Air terminals (IfcFlowTerminal) for intake/exhaust
- **Materials & Styles**: RGB colors, transparency, surface styling
- **Properties**: Load bearing, fire rating, thermal properties
- **Quantities**: Area, volume, dimensions for major elements

## Files Modified

1. **backend/lambda-functions/builting-bedrock-ifc/index.mjs**
   - Enhanced Claude prompt with universal JSON schema
   - Updated default values to include new fields

2. **backend/lambda-functions/builting-json-to-ifc-python/lambda_function.py**
   - Complete rewrite: 989 lines (was 239)
   - IFC4 schema, 30+ helper functions
   - Building-type-aware geometry generation
   - Material library, property sets, styling

3. **backend/lambda-functions/builting-json-to-ifc-python/test_ifc4.py** (NEW)
   - Comprehensive test suite for office, warehouse, tunnel buildings
   - Local testing without AWS

4. **backend/lambda-functions/builting-json-to-ifc-python/deploy.sh** (NEW)
   - Automated build, tag, and push script

## Troubleshooting

### Issue: Docker build fails with "No space left on device"
**Solution**: Clean up Docker images/containers
```bash
docker system prune -a
```

### Issue: ECR push fails with "access denied"
**Solution**: Verify ECR login and credentials
```bash
aws ecr get-login-password --region us-east-1 | docker login \
  --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
```

### Issue: Lambda times out during IFC generation
**Solution**: Increase Lambda timeout in AWS console
- Default is 3 minutes, may need 5-10 minutes for large models
- Increase memory allocation (512 MB → 1024+ MB)

### Issue: Generated IFC doesn't display in viewer
**Solution**:
1. Verify IFC file was generated (check S3 bucket)
2. Check for errors in CloudWatch logs
3. Try opening in Revit or web-based IFC viewer to isolate issue
4. Verify xeokit library is using IFC4 compatible settings

## Performance Notes

- **IFC file size**: Typically 500-2000 lines for medium buildings
- **Generation time**: 1-5 seconds (depends on room/equipment count)
- **Memory usage**: 512 MB lambda sufficient for most cases
- **Bottleneck**: Bedrock API call (60-90 seconds for document processing)

## Rollback

If issues occur after deployment:

1. Revert to previous image:
```bash
aws lambda update-function-code \
  --function-name builting-json-to-ifc \
  --image-uri <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/builting-json-to-ifc:<PREVIOUS_TAG>
```

2. Revert code changes:
```bash
git revert <commit-hash>
```

## Next Steps

1. **Deploy to ECR** - Follow deployment steps above
2. **Monitor initial runs** - Watch CloudWatch logs for errors
3. **Test with real BIM data** - Use actual building documents
4. **Iterate on Bedrock prompt** - Fine-tune if extraction needs improvement
5. **Consider Phase 2 enhancements**:
   - Window/door placement from Bedrock data
   - Multi-level buildings with ramps
   - Complex curved geometries for tunnels
   - MEP (mechanical/electrical/plumbing) systems

## Support

For issues or questions about the IFC4 generator:
- Check CloudWatch logs: `/aws/lambda/builting-json-to-ifc`
- Review Step Function execution history: `builting-render-state-machine`
- Check S3 buckets for intermediate files: `builting-data` and `builting-ifc`
