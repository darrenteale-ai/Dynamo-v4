# Dynamo app

Incident reporting, GDPR tools and fleet management for Medical Emergency Solutions.
Deployed on Railway (service `dynamo-app`, EU / Amsterdam). Start: `bun index.tsx`.
All secrets and settings are Railway environment variables; none are stored in this repo.

Deploys automatically from the `dynamo-app` branch. Do not merge into `main` (the old Dynamo-v4 service deploys from main).
