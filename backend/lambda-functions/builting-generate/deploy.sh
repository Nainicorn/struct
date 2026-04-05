#!/bin/bash
# Deploy script for builting-json-to-ifc Lambda function (container image)
# Automatically bumps cache salt and wipes S3 cache on every deploy.

set -e

LAMBDA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="builting-json-to-ifc"
AWS_REGION="${AWS_REGION:-us-gov-east-1}"
AWS_PROFILE="${AWS_PROFILE:-leidos}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID not set}"
IFC_BUCKET="builting-ifc"

# --- Auto-bump cache salt in lambda_function.py ---
LAMBDA_PY="$LAMBDA_DIR/lambda_function.py"
CURRENT_SALT=$(grep -oP "__v\K[0-9]+" "$LAMBDA_PY" | head -1)
if [ -n "$CURRENT_SALT" ]; then
    NEXT_SALT=$((CURRENT_SALT + 1))
    sed -i '' "s/__v${CURRENT_SALT}_/__v${NEXT_SALT}_/" "$LAMBDA_PY"
    echo "Cache salt bumped: v${CURRENT_SALT} -> v${NEXT_SALT}"
else
    echo "Warning: could not find cache salt in lambda_function.py"
fi

# Build the Docker image for arm64 (required for Lambda)
echo "Building Docker image: $IMAGE_NAME:latest (arm64)..."
docker build --platform linux/arm64 --provenance=false -t "$IMAGE_NAME:latest" "$LAMBDA_DIR"

if [ $? -ne 0 ]; then
    echo "❌ Docker build failed"
    exit 1
fi

echo "✓ Docker image built successfully"

# Tag for ECR
ECR_REPO="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$IMAGE_NAME"
echo ""
echo "🏷️  Tagging image for ECR: $ECR_REPO:latest"
docker tag "$IMAGE_NAME:latest" "$ECR_REPO:latest"
docker tag "$IMAGE_NAME:latest" "$ECR_REPO:$(date +%Y%m%d-%H%M%S)"

# Push to ECR
echo ""
echo "📤 Pushing to ECR..."
echo "Note: Make sure you're logged in to ECR. Run:"
echo "  aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
echo ""

if docker push "$ECR_REPO:latest"; then
    echo "Image pushed to ECR successfully"

    # --- Wipe S3 IFC cache so stale geometry is never served ---
    echo ""
    echo "Wiping S3 IFC cache (s3://$IFC_BUCKET/cache/)..."
    aws --profile "$AWS_PROFILE" s3 rm "s3://$IFC_BUCKET/cache/" \
        --recursive --region "$AWS_REGION" 2>/dev/null || true
    echo "Cache wiped."

    echo ""
    echo "Next steps:"
    echo "1. Update Lambda function to use new image:"
    echo "   aws lambda update-function-code \\"
    echo "     --function-name builting-json-to-ifc \\"
    echo "     --image-uri $ECR_REPO:latest \\"
    echo "     --region $AWS_REGION \\"
    echo "     --profile $AWS_PROFILE"
    echo ""
    echo "2. Monitor the update in CloudWatch Logs"
else
    echo "Failed to push image to ECR"
    exit 1
fi
