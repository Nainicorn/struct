---
name: deploy-lambda
description: "Deploy a Lambda function to AWS GovCloud. Use when the user says /deploy-lambda <name> or asks to deploy a lambda. Handles both zip-based (Node.js) and Docker/ECR (builting-generate) deploy paths."
---

# Deploy Lambda

Deploy a named Lambda function to AWS GovCloud (`us-gov-east-1`, profile `leidos`, account `008368474482`).

## Usage
```
/deploy-lambda <function-name>
```
Example: `/deploy-lambda builting-topology-engine`

---

## Deploy Paths

### Zip-based Lambdas (all except builting-generate and builting-extract)

**Functions**: `builting-router`, `builting-read`, `builting-resolve`, `builting-store`, `builting-sensors`, `builting-topology-engine`

**builting-topology-engine** (uses build-zip.mjs):
```bash
cd /Users/nainicorn/Documents/text-to-3D/backend/lambda-functions/builting-topology-engine
node build-zip.mjs
aws --profile leidos lambda update-function-code \
  --function-name builting-topology-engine \
  --zip-file fileb://builting-topology-engine.zip \
  --region us-gov-east-1
```

**Other zip lambdas** (builting-router example — adapt for each):
```bash
cd /Users/nainicorn/Documents/text-to-3D/backend/lambda-functions/builting-router
zip -q -r /tmp/builting-router.zip index.mjs auth.mjs db.mjs renders.mjs uploads.mjs users.mjs node_modules/
aws --profile leidos lambda update-function-code \
  --function-name builting-router \
  --zip-file fileb:///tmp/builting-router.zip \
  --region us-gov-east-1
```

**builting-resolve** (no node_modules, zip just the source files):
```bash
cd /Users/nainicorn/Documents/text-to-3D/backend/lambda-functions/builting-resolve
zip -j /tmp/builting-resolve.zip index.mjs normalize.mjs resolve.mjs identity.mjs schemas.mjs spatialValidation.mjs
aws --profile leidos lambda update-function-code \
  --function-name builting-resolve \
  --zip-file fileb:///tmp/builting-resolve.zip \
  --region us-gov-east-1
```

---

### builting-extract (S3 upload — zip exceeds 50MB)
```bash
cd /Users/nainicorn/Documents/text-to-3D/backend/lambda-functions/builting-extract
npm run build
# Copy mupdf wasm into dist first
cp dist/mupdf-wasm.wasm dist/ 2>/dev/null || true
# Zip: include dist/ + sharp native binaries
zip -r /tmp/builting-extract.zip dist/ node_modules/sharp node_modules/@img
aws --profile leidos s3 cp /tmp/builting-extract.zip \
  s3://builting-data/lambda-deployments/builting-extract.zip \
  --region us-gov-east-1
aws --profile leidos lambda update-function-code \
  --function-name builting-extract \
  --s3-bucket builting-data \
  --s3-key lambda-deployments/builting-extract.zip \
  --region us-gov-east-1
```

---

### builting-generate (Docker/ECR container)
```bash
AWS_ACCOUNT_ID=008368474482
LAMBDA_DIR=/Users/nainicorn/Documents/text-to-3D/backend/lambda-functions/builting-generate

# Login to ECR
aws --profile leidos ecr get-login-password --region us-gov-east-1 \
  | docker login --username AWS --password-stdin \
    ${AWS_ACCOUNT_ID}.dkr.ecr.us-gov-east-1.amazonaws.com

# Build arm64 image
docker build --platform linux/arm64 --provenance=false \
  -t builting-json-to-ifc:latest "$LAMBDA_DIR"

# Tag and push
docker tag builting-json-to-ifc:latest \
  ${AWS_ACCOUNT_ID}.dkr.ecr.us-gov-east-1.amazonaws.com/builting-json-to-ifc:latest
docker push \
  ${AWS_ACCOUNT_ID}.dkr.ecr.us-gov-east-1.amazonaws.com/builting-json-to-ifc:latest

# Update Lambda
aws --profile leidos lambda update-function-code \
  --function-name builting-json-to-ifc \
  --image-uri ${AWS_ACCOUNT_ID}.dkr.ecr.us-gov-east-1.amazonaws.com/builting-json-to-ifc:latest \
  --region us-gov-east-1
```

---

## After Deploy
Print the function ARN and LastModified timestamp to confirm the deploy succeeded:
```bash
aws --profile leidos lambda get-function-configuration \
  --function-name <name> \
  --region us-gov-east-1 \
  --query '[FunctionArn, LastModified, State]' \
  --output text
```
