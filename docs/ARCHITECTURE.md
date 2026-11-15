# ElderCare V2 architecture

## Current local demonstration topology

```text
React + Vite browser application
  ├─ role-based dashboards and accessible preferences
  ├─ FamilyPass / VoicePass / passkey client experiences
  ├─ medication, appointment, health, document and SOS screens
  └─ chat UI (one-time EventSource ticket)
          │ HTTPS in a deployment / HTTP on localhost
          ▼
Node.js 22 + Express API
  ├─ Firebase Admin ID-token verification (optional)
  ├─ local demo JWT verification (development only)
  ├─ membership + explicit permission middleware
  ├─ medication / appointment / health / documents / chat / SOS
  ├─ FamilyPass challenge / family records / invitations / audit
  ├─ WebAuthn passkey registration and assertion endpoints
  ├─ generic device-ingestion endpoint using hashed device tokens
  ├─ escalation policy / scheduler processor / SMTP adapter
  └─ optional OpenAI-compatible information-assistant adapter
          │
          ├─ SQLite database (local demo persistence)
          ├─ private local medical-document directory
          └─ private local family-photo directory
```

## Identity and authorization

- Local demo login issues a signed, time-limited token. Demo login is disabled automatically when `NODE_ENV=production`.
- When Firebase is configured, Firebase Admin verifies ID tokens. Existing accounts are matched by Firebase UID or verified email. Invited accounts need a matching verified email and a valid one-time invite.
- Profile access is based on an active `memberships` row and an explicit permission array. Backend routes call the membership/permission helper; hiding a frontend button is not treated as authorization.
- Membership changes, invitations, profile edits, device registration/revocation and passkey events write audit entries.

## FamilyPass boundary

The API makes two distinct relationship prompts from active family records, stores the correct targets server-side, randomizes answer options, and expires the challenge after five minutes. A challenge is limited to five verification attempts. Family photographs are private local files and are exposed only through short-lived pending challenge photo routes. The challenge is *not* an authentication factor. The patient must still sign in with email/password, Firebase Auth or a registered passkey.

## Passkey boundary

`@simplewebauthn/server` generates and verifies WebAuthn options and responses. Credentials are stored separately from user profile data; only the public key, counter, transports and credential metadata are stored. The package must be installed, and the relying-party ID/origin must exactly match the access domain. Use HTTPS outside localhost. This path has not been exercised against a real authenticator in the current build environment.

## Device boundary

An authorized patient/caregiver can register a device integration. The API returns a random credential once and persists only its SHA-256 hash. The device must submit `X-Device-Token` to the ingestion endpoint. The reading record is labelled `connected-device` only after credential validation. This is a generic API contract; BLE, Health Connect and manufacturer integrations are not included/tested.

## Scheduler and escalation

`POST /api/jobs/process` is protected by `x-job-secret`. It processes due medication reminders, missed/unconfirmed doses, alert follow-ups, secondary family escalation, appointment reminders, daily summaries and email deliveries. The repository does not create a real Cloud Scheduler job. A trusted scheduler must call the endpoint, and production jobs need durable idempotency and multi-instance coordination.

## Chat streaming

Chat messages persist in SQLite. A member obtains a short-lived one-time stream ticket from an authenticated route, then opens an EventSource endpoint. An in-process EventEmitter pushes updates to connected clients. Multiple API instances will not share the event stream; use a durable pub/sub service for production.

## AI provider boundary

The backend sends a bounded question to a configured OpenAI-compatible endpoint. The current-day patient summary is sent only if the user explicitly opts in. The assistant is instructed not to diagnose, prescribe, change medicine schedules or fabricate missing facts. It is not configured by default and must be reviewed against the provider's privacy terms.

## Not yet connected

- Firestore database persistence and transactional repositories.
- Private Firebase Storage documents/photos.
- Cloud Scheduler resource provisioning.
- Secret Manager and Cloud Logging/Monitoring resources.
- Web Push background notifications.
- Production multi-instance chat pub/sub.
- Actual connected device integrations.
- Public Cloud Run deployment.

SQLite and local file storage are not durable shared services for Cloud Run and are not suitable for actual patient data. Rules for Firestore and Firebase Storage stay default-deny until the adapters and exact data model are implemented and tested together.
