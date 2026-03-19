# Builting — Demo Prep Guide

A plain-English walkthrough of the entire application, written so you can answer any demo question confidently.

---

## What Is This App?

Builting takes messy, unstructured building data — text descriptions, PDFs, spreadsheets, blueprints, sensor files — and turns it into a real 3D model file (IFC format). IFC is the industry standard that tools like Revit, ArchiCAD, and BIM viewers understand. Think of it as "describe a building in words → get a 3D digital twin."

---

## How Does the Full Pipeline Work?


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

---

## Full Architecture Diagram (Text)

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
- **Bedrock** (Claude 3.5 Sonnet) provides the AI extraction without managing model infrastructure. It's an API call, not a deployed model.
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
- **AI-powered extraction**: Claude 3.5 Sonnet extracts building specs from unstructured text with multi-pass refinement
- **Standards-compliant IFC4**: Output opens in Revit, BIM viewers, and web viewers
- **Confidence-based output modes**: High-confidence data → full semantic BIM; low-confidence → proxy geometry with graceful degradation
- **Quality scoring**: 0-100 score combining semantic coverage, validation, structural completeness, and Revit compatibility
- **Full traceability**: Every element traces back to its source file, extraction method, and confidence level
- **Tunnel/infrastructure support**: Specialized pipeline for VentSim data with shell decomposition, duct segments, MEP systems, and spatial containment
- **Self-healing generation**: If semantic generation fails, automatically falls back to proxy mode
- **In-browser 3D viewing**: IFC files render in the browser with xeokit — no external tools needed
- **Clean, minimal codebase**: ~7 frontend components, 6 Lambda functions, no unnecessary dependencies

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

1. **Edit/retry failed renders** — let users fix input and re-run without re-uploading
2. **Complex curved geometries** — tunnels with arcs, variable cross-sections
3. **Revit round-trip proof** — formal validation that exported IFC imports cleanly into Revit
4. **Real-time sensor ingestion** — IoT data feeding into the digital twin
5. **CAD-quality geometry from blueprints** — advanced OCR and symbol recognition for architectural drawings
6. **Native glTF/OBJ export** — export 3D models in game-engine-friendly formats
7. **Real-time collaboration** — multiple users working on the same model
8. **Render versioning** — history of changes, diff between versions
9. **Mobile-responsive viewer** — touch controls for 3D navigation
10. **Cost optimization** — Lambda provisioned concurrency to eliminate cold starts for active users
