# Builting — Demo Prep Guide

A plain-English walkthrough of the entire application, written so you can answer any demo question confidently.

---

## What Is This App?

Builting takes messy, unstructured building data — text descriptions, PDFs, spreadsheets, blueprints, sensor files — and turns it into a real 3D model file (IFC format). IFC is the industry standard that tools like Revit, ArchiCAD, and BIM viewers understand. Think of it as "describe a building in words → get a 3D digital twin."

---

## How Does the Full Pipeline Work?

1. **User uploads files** (text, PDF, blueprints, spreadsheets, images, etc.) — the frontend requests presigned URLs from the backend, then uploads files directly to the S3 bucket (`builting-data`). No file data passes through the API server.
2. **Frontend calls `POST /api/renders/{id}/finalize`** — this tells the backend "all files are uploaded, start processing." The router Lambda kicks off the Step Function (`builting-state-machine`).
3. **builting-read** — fetches the render record from DynamoDB and lists all uploaded files from S3. Passes the file manifest to the next step.
4. **builting-extract** — downloads every uploaded file from S3 and parses them based on format (PDF pages via vision, DXF geometry, XLSX tables, VentSim simulation files, DOCX text, plain text). Uses Claude Sonnet 4.5 on Amazon Bedrock with multi-pass extraction to convert unstructured content into a structured JSON format called CSS (Construction Specification Schema). Also generates an AI title and description for the render.
5. **builting-resolve** — reads the raw extracted claims, normalizes units and naming conventions, groups claims by subject identity, resolves field-level conflicts (e.g., two sources disagree on a wall's height), assigns canonical IDs, and writes out clean normalized data.
6. **builting-topology-engine** — the heaviest step. Takes the normalized CSS and runs structural inference: snaps wall endpoints together, infers slabs and roof elevations, builds a spatial topology graph, generates the building envelope, mounts equipment to host elements, computes connection angles (mitre/butt/tee), runs safety checks, and produces a validation/readiness score (0–100).
7. **builting-generate** — converts the validated CSS into a real IFC4 file using IfcOpenShell (Python). Maps each element to its correct IFC class based on confidence level — high-confidence data gets full semantic BIM elements (IfcWall, IfcDoor, IfcDuctSegment, etc.), low-confidence data gets proxy geometry. Includes self-healing: if semantic generation fails for an element, it automatically falls back to a proxy box. Also exports glTF (.glb) and OBJ formats via trimesh.
8. **builting-store** — writes the results back to DynamoDB: IFC file path in S3, element counts, validation scores, output mode, and all quality metadata.
9. **builting-sensors** — seeds simulated sensor data for the digital twin. Maps IFC element types to appropriate sensor types (spaces get temperature sensors, ducts get airflow sensors, fans/pumps get equipment status sensors, columns/beams get structural load sensors). Stores readings in a dedicated DynamoDB table.
10. **Frontend polls for completion** — the sidebar checks every 8 seconds for in-progress renders. When the Step Function finishes, the render status flips to "completed," the frontend fetches the IFC file (base64-encoded), decodes it, and loads it into the xeokit 3D viewer.

---

## How Does the IFC Viewer Work?

The 3D viewer uses two libraries:
- **xeokit SDK** — a WebGL-based 3D engine built for BIM. It handles rendering, camera controls, element picking, and scene management.
- **web-ifc (WASM)** — a C++ IFC parser compiled to WebAssembly. It runs in the browser and parses the IFC file format into geometry that xeokit can render.

When a render completes, the IFC file comes back as base64 from the API. The frontend decodes it into an ArrayBuffer, hands it to the WASM parser, and xeokit renders the 3D scene. The camera auto-positions itself based on the model shape — it detects if something is elongated (like a tunnel) and switches to a side view. Users can click on any element and see its type, name, and IFC class in a little chip overlay.

---

## How Do Renders Show Up in the Sidebar?

When the layout loads, the sidebar calls `GET /api/renders` which returns all of the user's renders from DynamoDB, sorted by creation date (newest first). Each render card shows:
- **Thumbnail**: When a render completes, the viewer captures a snapshot of the 3D model (center-cropped, 200×200px JPEG). This gets cached in localStorage (up to 50 thumbnails). If no thumbnail exists yet, it shows a placeholder icon.
- **Title**: The AI-generated title from the Extract Lambda.
- **Status dot**: Green = completed, yellow = processing, red = failed.
- **Relative time**: "2h ago", "Just now", etc.

The sidebar also auto-polls every 8 seconds if it detects any in-progress renders, so when a render finishes, the card updates automatically with a notification.

---

## What Are the API Routes?

All routes go through the `builting-router` Lambda via API Gateway (AWS_PROXY integration). Every route except `/api/auth` requires a Bearer token in the Authorization header.

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/auth` | Login or signup — returns an HMAC-signed session token |
| `GET` | `/api/renders` | List all renders for the authenticated user |
| `POST` | `/api/renders` | Create a new render record (returns render ID + presigned upload info) |
| `GET` | `/api/renders/{id}` | Get full details for a specific render |
| `DELETE` | `/api/renders/{id}` | Delete a render and its associated S3 files |
| `GET` | `/api/renders/{id}/download?format=ifc\|glb\|obj` | Download the generated model in IFC, glTF, or OBJ format |
| `GET` | `/api/renders/{id}/report` | Download the validation report for a render |
| `POST` | `/api/renders/{id}/finalize` | Start the render pipeline (triggers the Step Function) |
| `POST` | `/api/renders/{id}/refine` | Re-process a render with user corrections |
| `GET` | `/api/renders/{id}/sensors` | Get live sensor readings for the render's digital twin |
| `POST` | `/api/renders/{id}/sensors/refresh` | Trigger a sensor data refresh |
| `GET` | `/api/renders/{id}/sources/{fileName}` | Download an original source file the user uploaded |
| `POST` | `/api/uploads/presigned` | Get presigned S3 URLs for direct browser-to-S3 file uploads |
| `GET` | `/api/users/{id}` | Get user profile information |

Every route also has an `OPTIONS` handler for CORS preflight requests.

---

## Full Architecture Diagram (Text)

```
User Browser (Vanilla JS + Handlebars + xeokit + web-ifc WASM)
     │
     ▼
API Gateway (builting-api)
     │
     ▼
builting-router (Lambda — Node.js)
     │
     ├── POST /auth ──────────────► DynamoDB (builting-users)
     │
     ├── POST /uploads/presigned ──► S3 (builting-data) ◄── browser uploads directly
     │
     ├── GET/POST/DELETE /renders ─► DynamoDB (builting-renders)
     │
     ├── GET /renders/{id}/sensors ► DynamoDB (builting-sensors)
     │
     └── POST /finalize ──────────► Step Functions (builting-state-machine)
                                         │
                                         ▼
                              ┌─────────────────────────┐
                              │     Pipeline (7 steps)   │
                              │                          │
                              │  1. builting-read        │
                              │     (DynamoDB + S3 list) │
                              │          ▼               │
                              │  2. builting-extract     │
                              │     (Bedrock / Claude    │
                              │      Sonnet 4.5 + parsers)│
                              │          ▼               │
                              │  3. builting-resolve     │
                              │     (normalize + merge)  │
                              │          ▼               │
                              │  4. builting-topology-   │
                              │     engine (structure +  │
                              │     geometry + validate) │
                              │          ▼               │
                              │  5. builting-generate    │
                              │     (CSS → IFC4 + glTF   │
                              │      + OBJ via Python)   │
                              │          ▼               │
                              │  6. builting-store       │
                              │     (DynamoDB update)    │
                              │          ▼               │
                              │  7. builting-sensors     │
                              │     (seed sensor data)   │
                              └─────────────────────────┘
                                         │
                                         ▼
                              S3 (builting-ifc) — generated models
                              DynamoDB (builting-renders) — metadata
                              DynamoDB (builting-sensors) — sensor readings
```

---

## Why This Tech Stack?

### Frontend: Vanilla JS + Handlebars + Vite
- **No framework on purpose.** React/Vue/Angular add bundle size, build complexity, and abstraction layers that aren't needed for this UI. The app has ~7 components — a framework would be overkill.
- **Handlebars** gives clean template separation without a full framework.
- **Vite** provides fast dev server, HMR, and a custom plugin for HBS compilation + WASM file management.
- **xeokit** is purpose-built for BIM/IFC visualization — it's the industry standard for web-based IFC viewing (used by BIMData, OpenProject, etc.). It handles massive models efficiently.

### Backend: AWS Serverless (Lambda + Step Functions + S3 + DynamoDB)
- **Serverless = no servers to manage.** Pay only when renders are running. Perfect for bursty workloads (user uploads → heavy processing → idle).
- **Step Functions** provide visual orchestration, automatic retries, and built-in error handling. Each Lambda is isolated — if the generator fails, the error gets caught cleanly and the render is marked as failed.
- **Lambda separation** follows single-responsibility: each step does one thing well. This makes debugging easy — check the CloudWatch log group for the specific Lambda that failed.
- **DynamoDB** is simple, fast, and scales automatically. The data model is straightforward (users + renders), so a NoSQL key-value store is a perfect fit.
- **S3** handles file storage naturally — presigned URLs let the browser upload directly without the backend being a bottleneck.
- **Bedrock** (Claude Sonnet 4.5) provides the AI extraction without managing model infrastructure. It's an API call, not a deployed model.
- **Single IAM role** with least-privilege custom policies keeps security tight without role sprawl.

### Why Not [Alternative]?
- **Why not a monolith backend?** A single server would need to handle file uploads, AI calls (30+ seconds), IFC generation (10-30 seconds), all synchronously. Lambda + Step Functions let each step scale and timeout independently.
- **Why not a relational DB?** The schema is simple and document-oriented (renders have nested JSON like elementCounts, tracingReport). DynamoDB handles this natively without migrations.
- **Why Python for Generate?** IfcOpenShell (the IFC creation library) is Python-only. Everything else is Node.js for consistency.

---

## How Did You Use Claude Code?

Claude Code (Anthropic's CLI tool) was used as the primary development partner throughout the project:

- **Architecture design**: Planning the Lambda pipeline, CSS schema design, and IFC generation strategy
- **Full-stack implementation**: Writing both frontend components and backend Lambda functions
- **Complex domain logic**: The IFC generation involves deep BIM knowledge — element types, spatial hierarchies, material assignments, geometry representations. Claude Code handled the IfcOpenShell integration and IFC4 spec compliance.
- **Iterative refinement**: Each version (v1 through v6+) was developed through conversation — describing what was wrong with the current output, planning fixes, implementing, testing, and iterating
- **Multi-pass pipeline design**: The extract → transform → generate pipeline was refined over many iterations to handle edge cases (tunnel structures, degenerate geometry, low-confidence data)
- **Debugging**: When renders failed, Claude Code helped trace through CloudWatch logs, identify which Lambda failed, and implement fixes
- **Documentation**: Maintaining CLAUDE.md, COMPLETED.md, and deployment guides

---

## Goals Achieved

- **Text-to-3D pipeline works end-to-end**: Upload a description of a building → get a valid IFC4 file
- **Multi-format ingestion**: Handles .txt, .pdf, .xlsx, .docx, .dxf, VentSim files, and images
- **AI-powered extraction**: Claude Sonnet 4.5 extracts building specs from unstructured text with multi-pass refinement
- **Standards-compliant IFC4**: Output opens in Revit, BIM viewers, and web viewers
- **Confidence-based output modes**: High-confidence data → full semantic BIM; low-confidence → proxy geometry with graceful degradation
- **Quality scoring**: 0-100 score combining semantic coverage, validation, structural completeness, and Revit compatibility
- **Full traceability**: Every element traces back to its source file, extraction method, and confidence level
- **Tunnel/infrastructure support**: Specialized pipeline for VentSim data with shell decomposition, duct segments, MEP systems, and spatial containment
- **Self-healing generation**: If semantic generation fails, automatically falls back to proxy mode
- **In-browser 3D viewing**: IFC files render in the browser with xeokit — no external tools needed
- **Clean, minimal codebase**: ~7 frontend components, 8 Lambda functions, no unnecessary dependencies

---

## System Design Tradeoffs

### Chose Serverless Over Always-On Servers
- **Pro**: Zero cost when idle, automatic scaling, no infrastructure management
- **Pro**: Each Lambda has independent timeout/memory settings (generate gets 10GB RAM for large models)
- **Con**: Cold starts add 1-3 seconds on first invocation
- **Con**: 15-minute Lambda timeout caps maximum processing time
- **Tradeoff**: Worth it — this app has bursty usage patterns (upload → heavy processing → nothing)

### Chose Step Functions Over Direct Lambda Chaining
- **Pro**: Built-in error handling — any Lambda failure triggers the catch block automatically
- **Pro**: Visual execution history in AWS console for debugging
- **Pro**: Each step is independently retryable
- **Con**: Adds ~500ms overhead per state transition
- **Tradeoff**: Worth it — the debugging and reliability benefits far outweigh the small latency cost

### Chose CSS (Intermediate Schema) Over Direct File-to-IFC
- **Pro**: Decouples extraction from generation — can improve either independently
- **Pro**: Transform step can validate/repair without touching the generator
- **Pro**: Enables caching (same CSS hash → skip regeneration)
- **Con**: Extra S3 read/write per render
- **Tradeoff**: Worth it — the intermediate format made iterative development much faster

### Chose Vanilla JS Over a Framework
- **Pro**: Tiny bundle size, fast load, no build complexity
- **Pro**: Full control over DOM, events, and rendering
- **Con**: No built-in state management or component lifecycle
- **Con**: Manual event wiring between components
- **Tradeoff**: Worth it for ~7 components. Would reconsider at 20+ components.

### Chose Base64 IFC Transfer Over Direct S3 Download
- **Pro**: Keeps S3 buckets private — no public URLs or complex CORS
- **Pro**: Auth handled by existing API gateway token
- **Con**: ~33% overhead from base64 encoding; large models hit API Gateway's 10MB limit
- **Tradeoff**: Acceptable for current model sizes. Could switch to short-lived presigned download URLs for larger files.

### Chose Single IAM Role Over Per-Lambda Roles
- **Pro**: Simpler to manage, fewer resources to track
- **Con**: Each Lambda has more permissions than it strictly needs
- **Tradeoff**: Mitigated by custom least-privilege policies. The 5 policies are already granular (specific tables, specific buckets, specific actions).

---

## Future Improvements

1. ~~**Edit/retry failed renders**~~ — **Done.** Users can refine renders via the `POST /api/renders/{id}/refine` endpoint, allowing corrections without re-uploading files.
2. **Complex curved geometries** — tunnels with arcs, variable cross-sections
3. **Revit round-trip proof** — formal validation that exported IFC imports cleanly into Revit
4. **Real-time sensor ingestion** — IoT data feeding into the digital twin
5. **CAD-quality geometry from blueprints** — advanced OCR and symbol recognition for architectural drawings
6. ~~**Native glTF/OBJ export**~~ — **Done.** The generate Lambda now exports glTF (.glb) and OBJ formats via trimesh alongside the IFC file. Users can download any format via `GET /api/renders/{id}/download?format=ifc|glb|obj`.
7. **Real-time collaboration** — multiple users working on the same model
8. **Render versioning** — history of changes, diff between versions
9. **Mobile-responsive viewer** — touch controls for 3D navigation
10. **Cost optimization** — Lambda provisioned concurrency to eliminate cold starts for active users
