---
name: v2 Pipeline Refactor Architecture
description: Architecture decisions for the v2 pipeline refactor — layered artifacts (claims → observed → inferred → resolved), stable identity model, adapter boundary for legacy Generate, field-specific source precedence
type: project
---

## v2 Pipeline Refactor (started 2026-03-14)

The pipeline is being restructured from a single mutable CSS object to layered artifacts:

**Artifact chain:** claims.json → normalized_claims.json → canonical_observed.json → inferred.json → resolved.json

**Key decisions:**
- `canonical_observed` = direct evidence only, no IFC types or geometry methods
- `resolved.json` = clean new schema, NOT CSS v1.0 shaped
- Legacy Generate compat via adapter (`resolvedToLegacyCss`), not by polluting new schemas
- Stable identity: `canonical_id` (persistent across revisions) + `instance_id` (per-run)
- Field-specific source precedence (not global GEOMETRY > SIMULATION > SCHEDULE > NARRATIVE)
- Claims support ambiguity: `status`, `alternatives`, `fieldConfidence`
- Every stage produces a subreport — no black boxes
- `exportHints` on resolved elements are advisory, not binding

**New Lambdas:** builting-resolve, builting-structure, builting-geometry, builting-validate

**Migration phases:** 0 (observability) → 1 (claims dual-write) → 2 (resolve) → 3 (split transform) → 4 (adapter) → 5 (validate) → 6 (refinement) → 7 (ECS)

**Full plan:** `.claude/plans/moonlit-sauteeing-muffin.md`
