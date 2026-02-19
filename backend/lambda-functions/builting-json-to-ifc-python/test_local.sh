#!/usr/bin/env bash
set -euo pipefail

ECR_REPO="builting-json-to-ifc"

echo "Building Docker image..."
DOCKER_BUILDKIT=1 docker build --platform=linux/amd64 -t ${ECR_REPO}:latest .

echo "Running container..."
CID=$(docker run -d --platform=linux/amd64 --rm -p 9003:8080 ${ECR_REPO}:latest)

echo "Waiting for local Lambda endpoint..."
for i in {1..20}; do
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:9003/2015-03-31/functions/function/invocations" | grep -qE "000|404|405|200"; then
    break
  fi
  sleep 1
done

echo "Invoking Lambda..."
RESP=$(curl -s "http://localhost:9003/2015-03-31/functions/function/invocations" \
  -H "Content-Type: application/json" \
  -d '{"buildingSpec":{"buildingName":"TestBuilding"}}' || true)

if [ -z "${RESP}" ]; then
  echo "ERROR: curl returned empty response."
  echo "---- container logs ----"
  docker logs "${CID}" || true
  echo "------------------------"
  docker stop "${CID}" >/dev/null || true
  exit 1
fi

# Parse JSON and check for IFC content
if echo "${RESP}" | python3 -c "import json, sys; data = json.loads(sys.stdin.read()); s = data.get('ifcContent', ''); print('SUCCESS!' if 'ISO-10303-21' in s else 'FAILED'); print('IFC size:', len(s), 'bytes')" 2>&1; then
  echo "✓ IFC generation verified!"
else
  echo "ERROR: Failed to parse response or invalid IFC"
  echo "Response: ${RESP:0:500}"
  docker stop "${CID}" >/dev/null || true
  exit 1
fi

echo "Stopping container..."
docker stop "${CID}" >/dev/null

echo "Done!"
