# Complete End-to-End Pipeline Guide

## 🎯 Full Data Flow Overview

```
User uploads files (PDFs, DWG, Excel, etc) to S3
         ↓
Files trigger SNS event via S3
         ↓
SNS → builting-orchestrator-trigger Lambda
         ↓
Step Function: builting-render-state-machine starts

    ┌─────────────────────────────────────────────┐
    │ Task 1: ReadMetadata                        │
    │ - Get render from DynamoDB                  │
    │ - List files from S3:builting-data/         │
    └──────────────┬──────────────────────────────┘
                   ↓
    ┌─────────────────────────────────────────────┐
    │ Task 2: BedrockInvokeIFC                    │
    │ - Download files from S3                    │
    │ - Extract text from PDFs, DOCX, XLSX, TXT  │
    │ - Call Bedrock Claude 3 Sonnet              │
    │ - Get JSON specs: dimensions, rooms,        │
    │   ventilation, equipment, titles            │
    └──────────────┬──────────────────────────────┘
                   ↓
    ┌─────────────────────────────────────────────┐
    │ Task 3: JsonToIFC (Python Lambda)           │
    │ - Parse buildingSpec JSON                   │
    │ - Generate IFC4 with IfcOpenShell           │
    │ - Create spatial structure:                 │
    │   Project → Site → Building → Storey        │
    │ - Create main geometry (IFCBEAM)            │
    │ - Create rooms, ventilation, equipment      │
    └──────────────┬──────────────────────────────┘
                   ↓
    ┌─────────────────────────────────────────────┐
    │ Task 4: StoreIFC                            │
    │ - Upload IFC to S3:builting-ifc/            │
    │ - Update DynamoDB with:                     │
    │   - ifc_s3_path                             │
    │   - ai_generated_title                      │
    │   - ai_generated_description                │
    └──────────────┬──────────────────────────────┘
                   ↓
Status updated to 'completed' in DynamoDB
         ↓
Frontend fetches IFC from S3
         ↓
xeokit viewer renders 3D geometry
```

---

## 🚀 Deployment Steps

### Step 1: Deploy Python Lambda Layer (57MB)

1. **AWS Lambda Console → Layers → Create layer**
   - Name: `builting-json-to-ifc-layer`
   - Runtime: `Python 3.11`
   - Upload file: `builting-json-to-ifc-layer-enhanced.zip`
   - Architecture: `x86_64`
   - Click "Create"
   - Note the Layer ARN: `arn:aws:lambda:us-east-1:ACCOUNT:layer:builting-json-to-ifc-layer:VERSION`

### Step 2: Create/Update Python Lambda Function

**Option A: Create New Function**
1. **AWS Lambda Console → Create function**
   - Name: `builting-json-to-ifc`
   - Runtime: `Python 3.11`
   - Architecture: `x86_64`
   - Click "Create"

**Option B: Update Existing Function**
1. **Go to existing function: `builting-json-to-ifc`**
2. Click "Upload from" → ".zip file"
3. Upload: `builting-bedrock-ifc-enhanced.zip`

**For Either Case:**
1. Set Handler: `lambda_function.handler`
2. Set Timeout: `300 seconds` (5 minutes)
3. Set Memory: `3008 MB` (max, for large file processing)
4. Scroll down to "Layers" section
5. Click "Add a layer"
6. Select "Custom layers"
7. Choose: `builting-json-to-ifc-layer` (version you just created)
8. Click "Add"
9. **Deploy!**

### Step 3: Update Step Function

1. **AWS Step Functions Console → States**
2. Select: `builting-render-state-machine`
3. Click "Edit"
4. Find the state that calls IFC generation (should be `BedrockInvokeIFC` → next → `JsonToIFC`)
5. Update the `JsonToIFC` task definition:

```json
{
  "Type": "Task",
  "Resource": "arn:aws:lambda:us-east-1:ACCOUNT:function:builting-json-to-ifc",
  "ResultPath": "$.ifcGenerationResult",
  "Next": "StoreIFC",
  "Catch": [
    {
      "ErrorEquals": ["States.ALL"],
      "Next": "HandleError"
    }
  ]
}
```

6. Click "Save" and "Deploy"

### Step 4: Test with Sample Files

1. **Upload test render using frontend**
   - Go to rendering interface
   - Upload files from `ifc/` folder:
     - `AC_Fan.pdf`
     - `Diesel_Exhuast_Fan.pdf`
     - `GMU_Sample_UGF_BeggarsTomb.dwg` (will be skipped - binary format)
     - `LEHE23262-01.pdf`
     - `Shaft_Fan.pdf`
     - Text description: "Underground command center with ventilation system"

2. **Monitor Step Function execution**
   - AWS Step Functions Console
   - Find your execution
   - Watch tasks complete in order:
     1. ReadMetadata ✓
     2. BedrockInvokeIFC (cloudWatch logs show Claude extracting specs)
     3. JsonToIFC (Python Lambda generates IFC)
     4. StoreIFC (uploads to S3, updates DynamoDB)

3. **Check frontend**
   - Render status should be "completed"
   - IFC should display in xeokit viewer
   - Click render thumbnail to see it

---

## 📊 File Support Matrix

| Format | Status | Processing |
|--------|--------|-----------|
| `.txt` | ✅ Supported | Read directly |
| `.pdf` | ✅ Supported | Extract text (pdf-parse) |
| `.docx` | ✅ Supported | Extract text (mammoth) |
| `.xlsx` | ✅ Supported | Extract tables (ExcelJS) |
| `.dwg` | ⚠️ Skipped | Binary format (can't parse) |
| `.ifc` | ⚠️ Skipped | Binary format (can't parse) |

**Note**: DWG files won't be analyzed by Bedrock, but the presence of other files (PDFs with ventilation specs, Excel equipment lists, etc.) will provide context for IFC generation.

---

## 🧪 Testing Checklist

- [ ] Lambda layer deployed and visible in Lambda Console
- [ ] Python Lambda function created/updated and layer attached
- [ ] Step Function definition updated with correct Lambda ARN
- [ ] Test render uploaded with sample files
- [ ] Step Function execution completes with all 4 tasks passing
- [ ] IFC displays in frontend xeokit viewer
- [ ] Can see AI-generated title and description from Bedrock
- [ ] Render can be deleted (cleanup works)
- [ ] Can create multiple renders (Step Function can be invoked multiple times)

---

## 🔍 Debugging

### If Step Function fails in BedrockInvokeIFC:
- Check CloudWatch logs for "BedrockInvokeIFC"
- Look for file extraction errors
- Verify files are UTF-8 text (not binary)
- Check Bedrock quota hasn't been exceeded

### If Step Function fails in JsonToIFC:
- Check CloudWatch logs for "JsonToIFC"
- Verify buildingSpec JSON from Bedrock is valid
- Check that dimensions fields exist (length_m, width_m, height_m)
- Ensure Lambda has sufficient timeout (300s)

### If IFC doesn't display in viewer:
- Check that file was uploaded to S3:builting-ifc/
- Verify IFC is valid ISO-10303-21 format
- Check xeokit viewer console logs for parsing errors
- Try downloading IFC and opening in Revit/CAD software

---

## 📝 Data Flow Example

**Input Files:**
- `AC_Fan.pdf` (2 pages, specifications for AC system)
- `LEHE23262-01.pdf` (specifications document)
- `description.txt` ("Underground facility for HVAC testing")

**Bedrock Extraction:**
```json
{
  "buildingName": "Underground Facility",
  "buildingType": "TUNNEL",
  "shortTitle": "HVAC Testing Lab",
  "longTitle": "Underground Facility for HVAC Equipment Testing",
  "description": "Underground testing facility equipped with AC fan systems and diesel exhaust fans for ventilation testing.",
  "dimensions": {
    "length_m": 150,
    "width_m": 12,
    "height_m": 4
  },
  "elevations": {
    "portal_west_m": 0,
    "portal_east_m": 150,
    "floor_level_m": -30
  },
  "ventilation": {
    "intake_location": "West end",
    "exhaust_location": "East end",
    "system_type": "Dual fan ventilation"
  },
  "equipment": [
    {
      "name": "AC Fan System",
      "type": "FAN",
      "location": "West intake",
      "specifications": "High capacity AC cooling"
    },
    {
      "name": "Diesel Exhaust Fan",
      "type": "FAN",
      "location": "East exhaust",
      "specifications": "Diesel-powered exhaust"
    }
  ]
}
```

**Generated IFC:**
- Valid ISO-10303-21 STEP format
- Spatial hierarchy: Project → Site → Building → Storey
- Main structure: IFCBEAM (150m × 12m × 4m)
- All dimensions and names from Bedrock JSON

---

## 🎯 Success Indicators

✅ **Full pipeline working when:**
1. Upload files → S3 event triggers immediately
2. Step Function starts and shows 4 tasks
3. BedrockInvokeIFC logs show file extraction
4. JsonToIFC logs show "IFC generated successfully"
5. StoreIFC logs show IFC uploaded and DynamoDB updated
6. Frontend render shows "completed" status
7. xeokit viewer displays 3D geometry
8. Render can be deleted (S3 files + DynamoDB record deleted)

---

## 📦 Deployment Files

| File | Size | Purpose |
|------|------|---------|
| `builting-json-to-ifc-layer-enhanced.zip` | 57MB | Lambda layer with IfcOpenShell + dependencies |
| `builting-bedrock-ifc-enhanced.zip` | 1.8KB | Python Lambda function code |

**Location:** `/Users/nainicorn/Documents/text-to-3D/backend/builting-json-to-ifc-python/`
