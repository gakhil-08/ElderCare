# ElderCare V2 — Better Care. Better Coordination. Greater Independence.

ElderCare V2 is a separate upgrade to the previous ElderCare project. It keeps the original local React/Vite + Express application and adds server-validated FamilyPass recognition, private family-photo storage, care-circle invitations and revocation, permission administration, audit history, passkeys (WebAuthn), connected-device ingestion credentials, configurable escalation policy, saved accessibility preferences, chat event streaming, and a configurable AI information assistant.

> **Safety and deployment boundary:** this is a hackathon demonstration build, not a certified clinical product or a production medical-record service. It runs on local SQLite and private local file storage. Firestore and Firebase Storage adapters are not implemented. Do not enter real patient data or deploy this build for real patient use. Cloud Run's local filesystem is ephemeral, and a real multi-instance service needs durable database/object storage and a production security review.

## V2 additions

- **FamilyPass:** backend creates a short-lived challenge with exactly two distinct family relationships, randomized options, attempt limits and server-side verification. Uploaded family photos are private local files with MIME/signature/size checks. FamilyPass is only a recognition exercise; a successful challenge never grants account access. The user must still complete secure account sign-in.
- **VoicePass:** browser speech-to-text can enter the account passphrase after the user explicitly consents. It is not voice biometrics and the app does not store audio. Speech recognition availability and processing are browser-dependent.
- **Passkeys:** optional WebAuthn registration and sign-in using `@simplewebauthn/server` and `@simplewebauthn/browser`. It requires successful package installation, a valid RP ID/origin and a supported secure browser/authenticator. This integration has not been exercised end-to-end in this environment.
- **Care-circle administration:** invite family/caregiver accounts with expiring one-time tokens, accept invitations, inspect profile memberships, change allowed permissions, revoke/reactivate access, and review audit events. Backend middleware verifies membership and permissions for protected APIs.
- **Family records:** add family members and relationship labels, upload private photos, and enable active/inactive records.
- **Patient profile:** update core identity, emergency contacts, doctor, conditions and allergies with permission checks and an audit/timeline record.
- **Device ingestion:** register a device integration; a random one-time token is stored as a hash. Revoke credentials and post health readings to the authenticated ingestion endpoint. A registry entry does not mean a physical sensor is connected; a reading is marked connected-device only after a valid token is presented.
- **Escalation policy:** set profile-specific primary caregiver and secondary family escalation intervals. A server-side scheduler must call the job endpoint for the rules to run.
- **Saved accessibility preferences:** persist selected language, text scale, high contrast, Simple Mode and voice-assistance setting per member/profile.
- **Chat stream:** authenticated profile members request a one-time ticket for a Server-Sent Events chat stream. The local EventEmitter works inside one running API process; it is not a cross-instance pub/sub service.
- **AI information assistant:** optional OpenAI-compatible chat-completions endpoint. It sends only the user question, and sends today's factual stored care summary only after the user checks the explicit sharing consent. AI output is labelled and constrained against diagnosis, prescriptions and dosage changes. It is unavailable until configured.

## Core care modules retained from V1

- Three demo roles: elderly patient, caregiver and family member, with distinct backend permissions.
- Medication schedules, event history, recorder/source attribution and self-reported dose status.
- Appointment create/edit/reschedule/cancel workflows.
- Manual BP, heart-rate, blood-glucose, SpO2 and temperature readings with data-source labels and trend charts.
- Explicit care-plan thresholds only; no universal medical thresholds or diagnosis.
- Care alerts, caregiver observations, healthcare timeline and factual daily summaries.
- Private local document upload/download/delete (PDF, PNG, JPEG; 8 MB maximum; files are not served from a public static directory).
- Persisted SOS events, optional one-time location request and acknowledgement/resolution. No automatic call to emergency services is made.
- In-app notifications and optional SMTP email processing. Email is opt-in and message bodies are generic to avoid exposing health details.
- Text-size, high-contrast, Simple Mode, English/Telugu/Hindi navigation labels and browser speech synthesis. Full reviewed translation and independent WCAG 2.2 AA audit remain outstanding.
- Health endpoint, Dockerfile and Cloud Build example.

## Demo accounts

All sample accounts use `Demo@123`:

| Role | Email | Display name |
|---|---|---|
| Elderly patient | `patient@eldercare.demo` | Mr. Rao |
| Caregiver | `caregiver@eldercare.demo` | Meera |
| Family member | `family@eldercare.demo` | Ananya Rao |

All seed readings, medication schedules, appointments, documents and observations are fictional demonstration data. Never enter actual patient information.

## Requirements

- Node.js 22 or newer (uses the built-in `node:sqlite` module; Node may print an experimental warning).
- npm.
- Modern browser. Passkeys require a supported authenticator and HTTPS or localhost. Browser speech recognition/synthesis support varies.

## Run locally on Windows

Extract the archive. Open two PowerShell terminals in the `ElderCare-V2` folder.

**Terminal 1 — backend**

```powershell
cd backend
Copy-Item .env.example .env
npm install
npm run dev
```

API: `http://localhost:8080`  
Health check: `http://localhost:8080/health`

**Terminal 2 — frontend**

```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`.

The database is initialized at `backend/data/eldercare.sqlite`. It seeds demo data on the first start. Uploaded medical documents and family photos are kept in `backend/uploads` and `backend/family-photos`; those folders are private and should be backed up when retaining a local demo. To reset the demo, stop the server and remove the SQLite database and its `-shm` / `-wal` companions; the next start recreates the sample data.

## Backend environment

Copy `backend/.env.example` to `backend/.env` and configure the services you actually intend to use.

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 8080). |
| `NODE_ENV` | Keep `development` locally; production disables demo login. |
| `DEMO_MODE` | Enables local sample-account login only outside production. |
| `DEMO_TOKEN_SECRET` | Replace with a long random local secret; not a production identity provider. |
| `CORS_ORIGIN` | Comma-separated frontend origins. Set exact deployed origins in a real deployment. |
| `FIREBASE_PROJECT_ID` | Enables Firebase Admin ID-token verification using Application Default Credentials. |
| `WEBAUTHN_RP_ID` | `localhost` for local testing; use your actual domain for production passkeys. |
| `WEBAUTHN_ORIGIN` | Exact browser origin, e.g. `http://localhost:5173`, with no trailing slash. |
| `JOB_SECRET` | Secret header for the scheduled job endpoint (`x-job-secret`). |
| `PRIMARY_ESCALATION_MINUTES` / `SECONDARY_ESCALATION_MINUTES` | Default fallback intervals; profile-specific values are stored in SQLite. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Optional invitation and notification email delivery. Configure a real mail provider and use test recipients. |
| `AI_ASSISTANT_URL` | OpenAI-compatible chat-completions endpoint. Leave blank to keep AI disabled. |
| `AI_ASSISTANT_API_KEY` | Optional provider API key; remains on the backend. |
| `AI_ASSISTANT_MODEL` | Model name expected by the configured provider. |
| `AI_ASSISTANT_PROVIDER` | Human-readable provider label. |

## Frontend environment

Copy `frontend/.env.example` to `frontend/.env`.

- `VITE_API_URL`: defaults to `http://localhost:8080/api`.
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`: required to activate Firebase email/password account login, password recovery and invited account creation in the browser.

For non-demo Firebase accounts, configure Firebase Authentication and Firebase Admin on the backend. An authenticated Firebase account must be linked to a local profile membership, either by an existing matching record with a verified email or by a valid invitation. Invitation acceptance requires the same verified email address as the invitation. The database in this build remains local SQLite; Firebase Authentication does not mean Firestore has been connected.

## Passkey setup

The project declares `@simplewebauthn/server` and `@simplewebauthn/browser` as dependencies. After `npm install` succeeds:

1. Run the app on `http://localhost:5173` and set `WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:5173` in the backend `.env`.
2. Sign in to an account and open **Accessibility & preferences → Passkeys & device authentication**.
3. Register a passkey on a device/browser that supports WebAuthn.
4. Sign out and choose **Passkey / device unlock** on the login screen.

For a deployed domain, configure the RP ID and exact HTTPS origin together. Do not copy localhost settings into production. The code is included, but passkey registration/sign-in was not executed end-to-end in this build environment.

## FamilyPass and photo setup

Sign in as the demo patient, open **Family members**, and upload permitted JPEG/PNG/WebP photographs for the sample relationships. FamilyPass asks two distinct relationship questions with randomized choices. It has a five-minute challenge expiry and a five-attempt limit. The visual challenge is a usability aid only; it is not an authentication factor and must never be used to release protected healthcare data without secure account login.

## Connected-device ingestion example

Sign in as a patient or caregiver with `devices:manage`, open **Connected health devices**, and register a connection. The API returns a random credential once; only the hash is stored. A device/gateway can send a reading like this:

```bash
curl -X POST "http://localhost:8080/api/device-ingest/INTEGRATION_ID/readings" \
  -H "Content-Type: application/json" \
  -H "X-Device-Token: ONE_TIME_DEVICE_TOKEN" \
  -d '{"parameter":"heart_rate","value":72}'
```

Supported parameter names: `blood_pressure` (include `secondaryValue`), `heart_rate`, `blood_glucose`, `spo2`, `temperature`. The endpoint is a generic integration contract; no named medical device or manufacturer API has been validated. A manually entered reading remains labelled manual.

## Scheduled processing and email

The browser does not run background reminders. Configure Cloud Scheduler or another trusted scheduler to call the backend endpoint on a recurring schedule (for example every five minutes):

```bash
curl -X POST https://YOUR_API_HOST/api/jobs/process \
  -H "x-job-secret: YOUR_JOB_SECRET"
```

The processor creates due medication reminders, marks stale unconfirmed medication events, creates/escalates care alerts, creates appointment reminders, generates daily summaries and attempts opt-in email delivery. This endpoint is not automatically scheduled by this repository. Configure timezone and the service's durable storage deliberately before any shared deployment.

## Tests and verification

Run the dependency-free schema/data tests:

```powershell
cd backend
node --test test-db.js
```

The current suite contains 10 database tests. It checks seeded roles, role permission separation, dose event provenance, opt-in email defaults, escalation/audit tables, distinct family relationships, passkey/invitation/device tables, device-token hash storage and profile-level escalation defaults.

After package installation, build the UI and run the server:

```powershell
cd frontend
npm install
npm run build

cd ..\backend
npm install
npm test
npm run dev
```

The checks completed in this workspace are recorded in `docs/ACCEPTANCE_STATUS.md`. A JSX syntax parse is not a substitute for a Vite production build; database tests are not API integration tests; and no browser E2E, pen-test, email-delivery or WCAG certification is claimed.

## Docker / Google Cloud

The root Dockerfile and `cloudbuild.yaml` are preparation artifacts only. They have not been built or deployed in a Google Cloud project. The current app stores data in local SQLite and local private folders; Cloud Run's filesystem is ephemeral and each instance would have its own database. **Do not deploy this version for actual patient records.** Before a production deployment, implement and test a durable database repository (Firestore or another appropriate managed database), private object storage, transactional authorization/audit behavior, backup/restore, key/secret management, structured logs, monitoring, scheduled job delivery, and independent security/privacy review.

Firestore and Firebase Storage rules are intentionally default-deny in this repository. Firebase Auth can be enabled separately, but Firestore persistence and Firebase Storage are not connected. See `docs/ARCHITECTURE.md` and `docs/ACCEPTANCE_STATUS.md` for the exact completion boundary.

## Security and healthcare limitations

- Backend routes check active profile membership and explicit permissions for protected operations.
- Firebase ID tokens are verified by Firebase Admin when configured. Demo tokens are local-only and disabled automatically in production.
- FamilyPass is not authentication. VoicePass is speech-to-text, not voice biometrics. Passkeys require correct relying-party deployment configuration.
- Uploaded medical files and family photographs use local private storage in this demo. Do not deploy with real patient records.
- A “taken” event is self-reported/caregiver-recorded, not proof of physical consumption.
- Health alerts use configured care-plan thresholds only; there are no hard-coded universal clinical limits.
- AI summaries are optional, explicitly consented when sending patient summary data, and are not clinical advice.
- SOS creates a persisted event and notifications only; it does not contact an emergency service or guarantee a response.
- The SSE chat event broadcaster is process-local. Use a durable shared pub/sub service for multi-instance production.
- No real sensor/device integration, cloud scheduler, Cloud Run deployment, Firestore, Firebase Storage or push notification service has been verified.
