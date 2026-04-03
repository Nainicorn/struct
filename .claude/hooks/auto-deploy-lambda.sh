#!/usr/bin/env bash
# Auto-deploy Lambda after Write/Edit tool calls on backend/lambda-functions/ files.
# Opt-out: touch .claude/hooks/auto-deploy-disabled to disable.
# Skips: builting-generate (Docker/ECR) and builting-extract (S3 upload, oversized zip).

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DISABLE_FLAG="$PROJECT_DIR/.claude/hooks/auto-deploy-disabled"
PROFILE="leidos"
REGION="us-gov-east-1"

# Opt-out guard
if [ -f "$DISABLE_FLAG" ]; then
  echo '{"hookSpecificOutput":{"additionalContext":"auto-deploy disabled (flag file present)"}}'
  exit 0
fi

# Read stdin JSON
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only act on lambda function files
if [[ "$FILE_PATH" != *"/backend/lambda-functions/"* ]]; then
  exit 0
fi

# Extract lambda name from path: .../backend/lambda-functions/builting-<NAME>/...
LAMBDA_NAME=$(echo "$FILE_PATH" | sed -n 's|.*/backend/lambda-functions/\(builting-[^/]*\)/.*|\1|p')

if [ -z "$LAMBDA_NAME" ]; then
  exit 0
fi

# Skip lambdas that require special deploy flows
case "$LAMBDA_NAME" in
  builting-generate)
    echo "{\"hookSpecificOutput\":{\"additionalContext\":\"Skipped $LAMBDA_NAME — requires Docker/ECR deploy (/deploy-lambda builting-generate)\"}}"
    exit 0
    ;;
  builting-extract)
    echo "{\"hookSpecificOutput\":{\"additionalContext\":\"Skipped $LAMBDA_NAME — requires S3 upload path (/deploy-lambda builting-extract)\"}}"
    exit 0
    ;;
esac

LAMBDA_DIR="$PROJECT_DIR/backend/lambda-functions/$LAMBDA_NAME"

if [ ! -d "$LAMBDA_DIR" ]; then
  echo "{\"hookSpecificOutput\":{\"additionalContext\":\"Lambda dir not found: $LAMBDA_DIR\"}}"
  exit 0
fi

echo "Auto-deploying $LAMBDA_NAME..." >&2

# Topology-engine uses build-zip.mjs
if [ "$LAMBDA_NAME" = "builting-topology-engine" ]; then
  cd "$LAMBDA_DIR"
  node build-zip.mjs 2>&1 >&2
  ZIP_FILE="$LAMBDA_DIR/builting-topology-engine.zip"
else
  # Generic zip for other lambdas
  ZIP_FILE="/tmp/${LAMBDA_NAME}.zip"
  cd "$LAMBDA_DIR"
  # Zip all .mjs files + package.json + node_modules if present
  ITEMS=()
  for f in *.mjs; do [ -f "$f" ] && ITEMS+=("$f"); done
  [ -f "package.json" ] && ITEMS+=("package.json")
  [ -d "node_modules" ] && ITEMS+=("node_modules/")
  zip -q -r "$ZIP_FILE" "${ITEMS[@]}" 2>&1 >&2
fi

# Deploy
aws --profile "$PROFILE" lambda update-function-code \
  --function-name "$LAMBDA_NAME" \
  --zip-file "fileb://$ZIP_FILE" \
  --region "$REGION" \
  --output text \
  --query 'FunctionArn' 2>&1 >&2

echo "{\"hookSpecificOutput\":{\"additionalContext\":\"Deployed $LAMBDA_NAME to AWS ($REGION)\"}}"
