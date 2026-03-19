#!/bin/bash
# Deploy script for builting-json-to-ifc Lambda function (container image)

set -e

LAMBDA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="builting-json-to-ifc"
AWS_REGION="${AWS_REGION:-us-gov-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID not set}"

# Build the Docker image for arm64 (required for Lambda)
echo "🐳 Building Docker image: $IMAGE_NAME:latest (arm64)..."
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
    echo "✓ Image pushed to ECR successfully"
    echo ""
    echo "📋 Next steps:"
    echo "1. Update Lambda function 'builting-json-to-ifc' to use new image:"
    echo "   aws lambda update-function-code \\"
    echo "     --function-name builting-json-to-ifc \\"
    echo "     --image-uri $ECR_REPO:latest \\"
    echo "     --region $AWS_REGION"
    echo ""
    echo "2. Monitor the update in CloudWatch Logs"
else
    echo "❌ Failed to push image to ECR"
    exit 1
fi
