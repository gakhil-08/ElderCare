# Cloud deployment preparation (not deployed)

The repository contains a Dockerfile and Cloud Build example, but deployment has not been attempted or verified. Do not deploy this version with real patient information: the app uses local SQLite and local file folders, which are ephemeral and instance-local on Cloud Run.

## Required work before public deployment

- Move application records to a durable managed database and replace local document/family photo folders with private object storage.
- Implement and test matching Firebase/Firestore/Storage authorization rules and server authorization.
- Configure Firebase Authentication providers and backend service-account permissions.
- Put all secrets in Secret Manager; do not place service-account JSON, SMTP passwords, AI keys or job secrets in source control.
- Configure a Cloud Run service account with least-privilege IAM, approved CORS origin, health checks and structured logs.
- Provision Cloud Scheduler with an authenticated `POST /api/jobs/process` request and secret header.
- Configure backups, retention, monitoring, alerting, multi-instance idempotency and shared chat pub/sub.
- Complete threat model, privacy/security review, automated API/E2E tests and accessibility audit.

## Illustrative commands after completing the architecture migration

```bash
# Build via Cloud Build (cloudbuild.yaml uses Artifact Registry substitutions)
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=asia-south1,_REPOSITORY=eldercare-images

# Deploy only after persistent services and secrets are configured.
gcloud run deploy eldercare \
  --image asia-south1-docker.pkg.dev/PROJECT_ID/eldercare-images/eldercare:COMMIT_SHA \
  --region asia-south1 \
  --service-account eldercare-runtime@PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars NODE_ENV=production,DEMO_MODE=false,FIREBASE_PROJECT_ID=PROJECT_ID \
  --set-secrets JOB_SECRET=eldercare-job-secret:latest
```

The commands are examples, not a completed deployment. Replace all placeholders, use the project's actual IAM and secret configuration, and migrate SQLite/local files before enabling public access. No Cloud Run URL is available from this work.
