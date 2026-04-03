# Pipeline Progress

## Phase 0 — Research Complete (2026-04-03)

### Deploy pipeline findings
- `builting-topology-engine`: `node build-zip.mjs` → zip → `aws lambda update-function-code --zip-file`
- `builting-extract`: requires S3 upload path (zip > 50MB) — skipped in auto-deploy hook
- `builting-generate`: Docker/ECR — skipped in auto-deploy hook (separate ECR flow)
- `builting-router`, `builting-read`, `builting-store`, `builting-sensors`, `builting-resolve`: manual zip → direct upload
- AWS profile: `leidos`, region: `us-gov-east-1`, account: `008368474482`

### Z-frame root cause confirmed (Bug #1)
- `normalizeGeometry` (validation.mjs:216): `shiftZ = -minZ`, shifts `placement.origin.z` (line 239)
- Does NOT shift: `levelsOrSegments[].elevation_m`
- Does NOT shift: `geometry.pathPoints` Z (only `geometry.vertices` shifted, lines 256-261)
- Mismatch cascades into: sill height (line 1454), storey-Z check (line 1696), MEP Z

### Other bugs confirmed with line numbers
- Bug #2: building-envelope.mjs:1696 — tolerance uses elevation_m not height_m
- Bug #3: building-envelope.mjs:2073-2076 — wall snap Z not propagated to child openings
- Bug #8: building-envelope.mjs:389 — floor-snap tolerance 0.3m (needs 0.5m)
- Bug #4: index.mjs:273 — `_defaultAxis = {x:0,y:0,z:1}` Z-up fallback
- Bug #5: index.mjs:344-351 — sort ascending only, no travel-direction check
- Bug #9: path-connections.mjs:20-40 — `getElementRunDirection` forces Z=0 in all branches
- Bug #11: repairCSS does not clamp negative elevations (pass-through is correct, audit `|| 0` patterns instead)

### Hook system
- PostToolUse hook config goes in `.claude/settings.local.json` under `hooks` key
- stdin JSON: `{ tool_input: { file_path }, tool_name }`
- No `skills/` or `agents/` dirs existed before Phase 1

---

## Phase 1 — Automation Infrastructure (2026-04-03)

### Status: COMPLETE

### Completed
- [x] 1.1 `.claude/hooks/auto-deploy-lambda.sh` — PostToolUse hook, opt-in guard, skips generate/extract
- [x] 1.1 `.claude/settings.local.json` — `hooks.PostToolUse` config added (async: true, 120s timeout)
- [x] 1.2 `.claude/skills/deploy-lambda/SKILL.md` — covers zip, S3, and ECR paths
- [x] 1.3 `.claude/skills/logs/SKILL.md` — `aws logs tail` with fallback
- [x] 1.4 `.claude/agents/lambda-deployer.md` — full Lambda architecture table, all deploy commands

### Test Results
- topology-engine file edit → hook fires, `node build-zip.mjs` runs, proceeds to deploy ✓
- unrelated UI file → hook exits silently (exit 0, no output) ✓
- builting-generate file → hook skips with JSON message, exit 0 ✓

### Files Created
- `.claude/hooks/auto-deploy-lambda.sh`
- `.claude/skills/deploy-lambda/SKILL.md`
- `.claude/skills/logs/SKILL.md`
- `.claude/agents/lambda-deployer.md`
- `progress.md` (this file)
- `todo.md`

### Modified
- `.claude/settings.local.json` (added `hooks` block)
