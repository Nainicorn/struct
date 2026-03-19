---
name: Always upload lambda zips to AWS
description: After zipping a lambda function, always upload it to AWS using aws lambda update-function-code — don't wait for user to ask
type: feedback
---

When a lambda function is updated and zipped, always upload it to AWS immediately using `aws lambda update-function-code`. Do not just create the zip and stop — the user expects deployment to happen automatically.
