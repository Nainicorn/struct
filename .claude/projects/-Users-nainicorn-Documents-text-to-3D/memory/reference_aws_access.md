---
name: AWS CLI Access
description: AWS CLI is configured — use it to upload Lambda zips, update code, update Step Functions, configure S3 CORS directly
type: reference
---

AWS CLI (`aws`) is pre-configured on the user's machine with full account access. Use it for:
- Uploading Lambda zip files (`aws lambda update-function-code`)
- Updating Step Function definitions (`aws stepfunctions update-state-machine`)
- Configuring S3 CORS (`aws s3api put-bucket-cors`)
- Any other AWS operations

Ask user only for console-only actions (IAM policy edits, API Gateway deployments, ECR image pushes).
