# GSTIN by sandbee

A free developer panel for GST lookups: React frontend, Node.js API, MongoDB storage and the existing local Python OCR worker. Production hostname: **gstapi.sandbee.in**.

## Run locally with Docker

Docker Engine/Desktop with Compose is required. From this directory:

```sh
node scripts/setup-env.js
docker compose up -d --build
```

Open **http://localhost:8080**. Create an account, verify its email with the OTP, finish workspace onboarding, generate an API key, and run a lookup in Playground. There are no default credentials or billing screens. Use `localhost` consistently: browser mutation requests must match the configured application origin.

The setup script creates random local secrets in `.env` without overwriting an existing file. MongoDB runs inside Docker with authentication and a persistent volume. Its port is not published. The app binds only to localhost for local development. Without Gmail credentials, OTP email is delivered to the private local Mailpit inbox at **http://localhost:8026**, never printed to the application UI or logs. Node and Python are installed inside the image; only the setup script needs local Node. Alternatively, create `.env` manually from `.env.example` with random secrets before running Compose.

```sh
docker compose ps
docker compose logs --tail 50 app
docker compose down
```

`down` keeps MongoDB data. Do not use `down -v` unless you intend to permanently erase local accounts and GST snapshots. Keep the generated Mongo password unchanged after database initialization; changing the environment variable alone does not rotate an existing MongoDB user's password.

## Product flow

1. Sign up with a name, email and password of at least 12 characters.
2. Verify the 6-digit email code, then set a workspace name and use case.
3. Generate one active API key. The full token is shown once; copy it to your calling server's environment.
4. Use the API or the authenticated playground. The dashboard shows only your own successful usage.
5. Replace/revoke a key in the panel. Changing your password signs out every session and revokes your API key.

The interface includes overview, key management, playground, integration examples, workspace settings and password change, with desktop and mobile layouts. Email verification and OTP-based password recovery are included. Billing is not configured. Existing accounts must verify their email before accessing the panel or using an API key.

## Gmail OTP and account recovery

Set the following in local `.env` (or production `.env.production`):

```dotenv
GMAIL_USER=your-sender@gmail.com
GMAIL_APP_PASSWORD=your-16-character-google-app-password
```

Use a Google App Password, not your normal Google account password. Spaces in the app password are removed automatically. The sender defaults to this Gmail address; `MAIL_FROM` can optionally be a configured Gmail sender alias. Gmail uses authenticated TLS on port 465. Allow outbound traffic to that port. See [Nodemailer's Gmail setup](https://nodemailer.com/usage/using-gmail/).

After editing ENV, recreate the app so Docker passes the updated settings:

```sh
docker compose up -d --force-recreate app
```

Both Gmail fields are required together. Production startup requires Gmail configuration and does not fall back to a test inbox. Locally, leaving both blank uses Mailpit at http://localhost:8026. This inbox is bound to localhost, and its SMTP port is only reachable by the Compose services. Set `MAILPIT_PORT` if 8026 is occupied. Local inbox messages are temporary; recreate/reset the inbox only when you no longer need those codes. Gmail inbox delivery still needs a real-credentials check after you configure ENV.

Signup creates a limited session and sends a verification code. Until verification, onboarding, key creation, playground and external API access are blocked. Failed email delivery leaves the account recoverable: sign in and request another code. Forgot password is available on the sign-in page: email ? OTP ? new password and confirmation ? sign in. A successful reset also verifies mailbox ownership and revokes all previous sessions and API keys.

Codes expire after 10 minutes, allow five attempts, have a 60-second resend cooldown and share a five-emails/hour account budget. Codes are bound to their purpose and account, protected with an HMAC, and consumed atomically. Reset grants are random, hashed, single-use and valid for 10 minutes. Only the existing `users` collection is used; no third collection is added.

Forgot-password requests return the same response whether an account exists or not. Email delivery runs in a bounded asynchronous queue to avoid SMTP-time account enumeration. Graceful shutdown waits for queued delivery; abrupt process termination can interrupt delivery, so users can request another code after cooldown. Password changes trigger an email notification without including the password. The safeguards follow the [OWASP recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## External API

```sh
curl "http://localhost:8080/api/v1/gstin/09AAFPC6958E1ZN" \
  -H "Authorization: Bearer $SANDBEE_API_KEY"
```

In production, replace the origin with `https://gstapi.sandbee.in`. Send the key only in the Authorization header. Login cookies alone cannot authorize this external endpoint. A caller must use a key generated by an onboarded account.

Successful response shape:

```json
{
  "success": true,
  "data": {
    "gstin": "09AAFPC6958E1ZN",
    "legalName": "Business legal name",
    "status": "Active"
  },
  "meta": {
    "source": "database",
    "fetchedAt": "2026-09-18T17:48:33.394Z",
    "elapsedMs": 4
  }
}
```

`data` also includes available trade name, company/taxpayer type, registration/cancellation dates, business activities, address and jurisdictions. `fetchedAt` is the original snapshot timestamp. `source` is `live` or `database`; it describes where this response came from. Concurrent callers may share one live lookup.

Errors use `{ "success": false, "error": { "code": "...", "message": "..." } }`.

| HTTP | Meaning |
| --- | --- |
| 400 | Invalid request or GSTIN checksum |
| 401 | Missing, invalid or revoked API key |
| 404 | GSTIN not found, or unknown API endpoint |
| 429 | Account/IP rate limit or portal rate limit |
| 502 | Invalid/unavailable portal response |
| 503 | OCR uncertain, live queue full or lookup timed out; observe Retry-After |

The account limit is 60 requests/minute, shared by the API and playground. An additional IP limit is 300 requests/minute, and signup/login have a 15-attempt/15-minute IP limit. Only successful resolved lookups increment account counters; cached requests count too. Failed authentication, invalid input and upstream failures do not increment usage. Rate limits are process-local; this deployment runs one app replica.

## Storage and cache

Exactly **two application collections** are created:

| Collection | Contents and indexes |
| --- | --- |
| `users` | Profile, email verification timestamp, hashed expiring OTPs/reset grants, mail-send budget, scrypt password hash, up to five hashed sessions, one hashed API key and atomic usage counters. Unique indexes on email, sparse API-key hash and sparse session hash. |
| `gst_records` | GSTIN, first successful response and fetchedAt. Unique GSTIN index. |

Lookup sequence:

1. Validate and normalize the GSTIN; check the bounded server LRU (`GSTIN -> 1`, 10,000 entries).
2. Perform an indexed MongoDB `findOne`. A missing LRU marker also checks MongoDB because eviction/restart cannot prove database absence.
3. Return an existing snapshot. Otherwise, call the live service with bounded retries and persist success using `$setOnInsert`.
4. Insert the marker and atomically increment **only the authenticated account's** counters using `$inc`.

The LRU stores presence markers, not response bodies. It does not eliminate the requested MongoDB read. Simultaneous misses for the same GSTIN share one promise in the process. Different live lookups are serialized, with at most four queued requests and a 10-second queue deadline. The unique index prevents duplicate GST records even if more than one process inserts concurrently.

Snapshots are permanent first-success results, as requested. They do not automatically refresh when a business's registration changes. The UI and API expose their age. OCR uncertainty and errors are never cached as successful data. Historical OCR evaluations are in [the research notes](docs/captcha-research.md); no finite test establishes accuracy on every possible future CAPTCHA.

## AWS / EC2 deployment

The production Compose file uses your existing MongoDB URL and Caddy for HTTPS. It does not start another MongoDB container or expose the Node port.

1. Copy the project to EC2 and install Docker with the Compose plugin. The built runtime has been tested on Linux x86-64.
2. Create `.env.production` from `.env.example`. Set a fresh random `SESSION_SECRET`, your `MONGODB_URI`, `MONGODB_DB=sandbee_gstin`, `DOMAIN=gstapi.sandbee.in`, `GMAIL_USER`, and `GMAIL_APP_PASSWORD`. Use a database-scoped application user with permission to read/write and create indexes. Keep the file private (`chmod 600 .env.production`).
3. Point the domain's DNS A record to the instance's public/Elastic IP. Only publish an AAAA record if IPv6 reaches this instance too.
4. Allow inbound TCP 80/443 in the EC2 security group; restrict SSH to your administrator IP. MongoDB and port 3000 should not be publicly exposed. Allow the EC2 host to reach your MongoDB service and the GST portal over HTTPS.
5. Start the production stack:

```sh
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml up -d --build
docker compose --env-file .env.production -f compose.production.yaml ps
```

Visit `https://gstapi.sandbee.in`, create your real account, and generate its key. No code changes are needed for the domain or MongoDB connection. Caddy obtains and renews a public certificate when DNS and ports are reachable; its certificate volumes persist across restarts. See [Caddy's HTTPS prerequisites](https://caddyserver.com/docs/automatic-https).

Compose reads the selected environment file and passes values into the containers. Single-quote connection URLs in the env file when they contain `$` so Compose does not interpolate them; URI-encode username/password characters as required by MongoDB. Do not share `docker compose config` output without redaction; it expands secrets. See [Docker's interpolation rules](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

Updates use the same `up -d --build` command. This single-instance deployment has a short restart interruption. Keep MongoDB backups and Caddy volumes. An image rollback must be coordinated with compatible code/data. The product has no subscription fee; EC2, domain and database hosting costs remain separate.

## Security implementation

- Passwords use salted scrypt (N=32768, r=8, p=3); this is one of the configurations documented by [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- Sessions and API keys contain 256 random bits and are stored only as SHA-256 hashes. API keys are displayed only at generation, with metadata-only retrieval thereafter.
- Sessions expire after seven days. Production cookies are HttpOnly, Secure, SameSite=Lax, host-only, and use the `__Host-` prefix.
- Cookie-authenticated mutations require the configured Origin plus a session-bound CSRF token. Request schemas are strict and JSON bodies are capped at 8 KB.
- Helmet supplies security headers and CSP. API responses are not cached by browsers/proxies. Internal exceptions do not expose stack traces or credentials.
- The container runs as a non-root user, with a read-only filesystem, dropped capabilities and no-new-privileges. Secrets are supplied at runtime and excluded from the image.
- Only the HTTPS proxy is public in production. Trust is configured for exactly that one proxy. Do not publish the app's port directly or add extra proxies without reviewing that setting.

## Development and tests

Active application code is organized as follows:

```text
frontend/src/     React shell, reusable UI components, individual pages, styles
backend/          HTTP API, configuration, authentication, database, GST cache service
lib/              GST portal client, bounded lookup flow, persistent OCR worker
server.js         Application bootstrap and graceful shutdown
captcha_*.py      Local image processing and OCR
scripts/          Environment setup and OCR evaluation tools
test/             Node, Python and browser tests; isolated MongoDB test helper
deploy/           Caddy HTTPS configuration
```

The runtime serves only `frontend/dist`; old standalone HTML endpoints are not mounted. User-managed legacy files are excluded from Docker builds.

```sh
npm ci
npm run build
npm test
npm run test:ui
npm run check
```

Node/API/browser tests use disposable local MongoDB processes, not your application database or the live GST portal. The first run downloads a MongoDB test binary. Windows browser tests use installed Microsoft Edge; on Linux install Chromium with `npx playwright install --with-deps chromium`.

Python regression tests require Python 3.12 with `requirements.txt` installed:

```sh
python -m unittest discover -s test -p test_ocr.py
```

For native development, supply a reachable local `MONGODB_URI`, random `SESSION_SECRET`, and `APP_URL=http://localhost:5173` in `.env`; run `npm run dev:api` and `npm run dev:web` in separate terminals. The Vite dev server proxies API calls to Node on port 3000. Set up `.venv` with Python 3.12 and `pip install -r requirements.txt`, or configure `GST_PYTHON` explicitly. Docker is the simpler default.

Verified during the SaaS build: authenticated live lookup of the supplied GSTIN, reuse from MongoDB, isolated usage counts, key replacement/revocation, password/session revocation, CSRF, production cookie flags, limits, cache misses after restart, concurrent requests, browser onboarding and mobile layout. Local sample timings were 385 ms live and 4 ms saved; they are observations, not latency guarantees.
