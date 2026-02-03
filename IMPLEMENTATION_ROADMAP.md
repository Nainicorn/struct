# Text-to-3D Backend Implementation Roadmap

**Project:** AI-Powered Text-to-3D Model Generation (BuilTING - Leidos Team 2)
**Current Date:** January 25, 2026
**Target Completion:** 2 weeks

---

## Current Status
- ✅ Frontend: Complete (xeokit viewer, login, controls)
- ✅ Trade Study: Complete (using Bedrock Claude)
- ❌ AWS Infrastructure: Not started
- ❌ Backend: Not started

---

## Tech Stack & Services

### Frontend (Already Complete)
- **Framework:** Vanilla JS
- **3D Viewer:** xeokit
- **Authentication:** Login system

### AWS Services (Backend)
- **API Gateway** - REST API endpoints
- **Lambda** - Serverless compute (Python 3.11+)
- **S3** - File storage
- **Bedrock** - Claude 3.5 Sonnet API
- **CloudWatch** - Logging & monitoring
- **IAM** - User roles & permissions

### Python Libraries
- `boto3` - AWS SDK
- `IfcOpenShell` - IFC file generation (Lambda layer)
- `PyPDF2` - PDF text extraction
- `Pillow` - Image handling
- `requests` - HTTP calls
- `json` - Data parsing

### Lambda Functions
| Function | Purpose |
|----------|---------|
| `parse_documents` | Extract building specs from files (text, PDF, images, sensor data) |
| `generate_ifc` | Convert specs to IFC format |

### API Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/upload` | Upload files |
| POST | `/api/process` | Start processing |
| GET | `/api/status/{projectId}` | Check status |
| GET | `/api/download/{projectId}` | Download IFC |
| GET | `/api/references/{projectId}` | View source citations |
| GET | `/api/projects` | List user projects |

### Development Tools
- AWS SAM CLI (local Lambda testing)
- AWS CLI
- Python 3.11+
- Git
- Revit 2023+ (validation)

---

## Phase 1: AWS Setup & Infrastructure

### 1.1 AWS Account & Permissions
- Verify AWS account access (use existing account)
- Enable Bedrock service in us-east-1 or us-west-2
- Request/enable Claude 3.5 Sonnet model access
- Create IAM role for Lambda with permissions:
  - `s3:GetObject`, `s3:PutObject` (for file storage)
  - `bedrock:InvokeModel` (for Claude API calls)
  - `logs:CreateLogGroup`, `logs:PutLogEvents` (for CloudWatch)

### 1.2 S3 Storage Setup
- Create S3 bucket: `builting-documents-prod`
- Create folder structure:
  ```
  builting-documents-prod/
  ├── uploads/{userId}/{projectId}/    # Raw input files (PDF, images, text)
  ├── processing/{projectId}/          # Processing status & logs
  ├── outputs/{userId}/{projectId}/    # Generated IFC files
  └── references/{projectId}/          # Verification data (what sources Claude used)
  ```
- Enable encryption (SSE-S3)
- Set lifecycle: delete processing files after 7 days

### 1.3 API Gateway Setup
- Create REST API in API Gateway
- Enable CORS for frontend domain
- Create these endpoints:
  - `POST /api/upload` → Upload files (PDF, images, text, sensor data)
  - `POST /api/process` → Start processing a project
  - `GET /api/status/{projectId}` → Get processing status
  - `GET /api/download/{projectId}` → Download generated IFC file
  - `GET /api/references/{projectId}` → Get human verification data (what sources Claude used)
  - `GET /api/projects` → List user's projects
- Deploy to dev stage

### 1.4 Local Development Setup
- Install AWS SAM CLI
- Set up local Lambda testing environment
- Configure AWS credentials locally

---

## Phase 2: Document Processing (Bedrock Claude)

### 2.1 Parse & Extract Building Specs
- Create Lambda function: `parse_documents`
- This function handles:
  - **Text files**: Pass directly to Claude
  - **PDFs**: Extract text content first
  - **Images/Blueprints**: Send directly to Claude's vision capability
  - **Sensor data**: Include as structured JSON input
- Call Bedrock Claude with system prompt to extract building structure

### 2.2 Claude System Prompt & Output Format
- Design prompt to extract building specs and cite sources
- Example output format:
  ```json
  {
    "building": {
      "name": "string",
      "description": "string",
      "totalArea": "number (m²)",
      "floors": "number"
    },
    "rooms": [
      {
        "id": "string",
        "name": "string",
        "floor": "number",
        "length": "number (m)",
        "width": "number (m)",
        "height": "number (m)",
        "area": "number (m²)",
        "purpose": "string"
      }
    ],
    "elements": {
      "walls": [
        {"id": "string", "type": "external|internal", "length": "number"}
      ],
      "doors": [{"id": "string", "count": "number", "width": "number", "height": "number"}],
      "windows": [{"id": "string", "count": "number", "width": "number", "height": "number"}]
    }
  }
  ```

### 2.3 Store Results & Create Verification Data
- Save extracted specs to S3: `metadata/{projectId}/specs.json`
- Save reference data to S3: `references/{projectId}/sources.json` (what Claude cited)
- Handle errors gracefully:
  - Invalid JSON from Claude → retry with corrected prompt
  - Large files → truncate with warning
  - Missing measurements → use defaults and flag for user

---

## Phase 3: IFC Generation

### 3.1 IfcOpenShell Setup
- Install IfcOpenShell Python library locally
- Package as Lambda layer (must be <262MB):
  - Build on Amazon Linux 2
  - Create ZIP with all dependencies
  - Test with `sam build`
- Create helper functions for common IFC operations

### 3.2 Generate IFC File
- Create Lambda function: `generate_ifc`
- Read specs from S3 and convert to IFC:
  - Create IfcBuilding (top level)
  - Create IfcBuildingStorey for each floor
  - Create IfcSpace for each room with geometry (length × width × height)
  - Create IfcWall, IfcDoor, IfcWindow elements
  - Set up proper placement and relationships
- Save IFC file to S3: `outputs/{userId}/{projectId}/model.ifc`
- Test with simple cases first (single room → multi-room)

---

## Phase 4: Frontend Integration

### 4.1 Update Frontend Code
- Update API base URLs to point to API Gateway
- Modify upload button to call `/api/upload`
- Add progress indicator during processing (shows status)
- Modify download button to call `/api/download/{projectId}`
- Display verification data from `/api/references/{projectId}` (show what Claude cited)

### 4.2 xeokit Viewer
- Download IFC file from API
- Load into xeokit viewer
- Display room properties on click
- Add basic selection/highlighting

---

## Phase 5: End-to-End Testing

### 5.1 Test Full Pipeline
- Test with different input types:
  - Simple text descriptions
  - PDF documents with building specs
  - Blueprint images
  - Sensor data
- Verify output works in xeokit viewer
- Check processing time (target: <2-3 min per document)

### 5.2 Validate IFC Files
- Import into Revit 2023+ to verify:
  - File opens without errors
  - Geometry displays correctly
  - Rooms are recognized
  - No missing relationships
- Fix any IfcOpenShell issues that arise

---

## Phase 6: Polish & Documentation

### 6.1 Error Handling & Edge Cases
- Handle API failures gracefully
- Set Lambda timeout to 15 minutes
- Add input validation
- Implement retry logic for transient failures
- Set up CloudWatch alarms for failures

### 6.2 Documentation
- Create API documentation (endpoints, request/response format)
- Write deployment guide (AWS setup, environment variables)
- Write development guide (local setup, testing)
- Document known limitations and assumptions

---

## Stretch Goals (If Time)

### 6.3 Agentic Processing
- Build agentic system to:
  - Automatically detect and ingest new input files
  - Incrementally update existing IFC files
  - Feed human edits back to Claude for refinement
  - Generate updated models based on human feedback

