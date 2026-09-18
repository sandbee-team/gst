# GSTIN by Sandbee — design spec

Date: 2026-09-18. Status: approved for implementation (v1).

A web app and REST API that returns Indian GST registration details for a GSTIN, using the public GST portal with local CAPTCHA OCR. No paid services. One Node 22 process, one Python OCR child, one MongoDB. Built on the existing, live-verified foundation in `lib/` (`gst-client.js`, `lookup.js`, `ocr-worker.js`) and `captcha_ocr.py`.

This document is the contract between the modules. Section 4 (interfaces) and section 5 (error codes) are normative: every module is built against them and tested with stubs of its neighbours.

---

## 1. Goals, non-goals, honest ceiling

### Goals
- Signup / email verification / login / password reset / onboarding; dashboard and API keys.
- `POST /api/v1/lookups` for one GSTIN per request, from many users at once.
- A 1000-request burst on a 1–2 vCPU, 1–2 GB server must be handled **properly**: no crash, bounded memory, no portal ban, every client gets a truthful HTTP response, nothing is silently dropped.
- Web users keep the manual CAPTCHA fallback when OCR abstains.
- Runs in Docker; local MongoDB now, MongoDB Atlas M0 (512 MB) later with only `MONGO_URL` changing.
- Everything testable without the live portal.

### Non-goals (v1)
- Bulk upload endpoint. Cache-only `GET /api/v1/gstin/{gstin}` is the bulk fast path; a single key needing 1000 distinct uncached GSTINs is truthfully rate-limited.
- Billing, plans beyond `free`, admin UI, OAuth login, SSE/WebSockets, Redis, multiple Node processes, multiple OCR workers.
- Deferred from the architecture panel (interfaces preserved so they can be added later): storage watchdog with TTL tightening, background revalidation lane, multi-web-subscriber CAPTCHA offer protocol, OCR RSS watchdog. Abstain-rate monitor ships in a simple form.

### The ceiling is the portal
Measured: median lookup 1.0 s (591–3620 ms over 10 live runs), OCR 33 ms, ~10 % images abstained, all 10 lookups succeeded, 0 wrong submissions, all sequential. The portal resets connections under rapid hits. Behaviour at concurrency > 1 is **unmeasured**.

Model: service time 1.15 s per lookup, 2.2 portal HTTP hits per lookup. Concurrency 1 → 0.87 lookups/s. Concurrency 2 → 1.74 lookups/s (3.8 hits/s).

Consequence: 1000 distinct uncached GSTINs cannot be answered in seconds by anyone. The design answers cache hits in milliseconds, coalesces duplicates, holds a request up to 25 s for a synchronous answer, and otherwise returns `202` with a durable job id to poll. A full cold 1000-job queue drains in ~10 minutes at the ramped rate.

---

## 2. Architecture

```
HTTP  →  Auth  →  Admission  →  [ L1 cache → Mongo cache (batched) → coalesce → per-owner caps → depth cap → gate state ]
                                      │ hit                                                  │ miss
                                      ▼                                                      ▼
                                   200 now                          Ledger.insertLeaders (awaited)  →  Notifier.hold(≤25 s)
                                                                                                             │
      Dispatcher loop:  queue.next() → gate.acquire() → runner.runJob(lookup.js, gated client, supervised solver)
                          → outcome → cache.set / ledger.update / quota.charge / notifier.resolve / challenges.put
```

Single process. All timing goes through an injected `clock`. All external I/O (`client`, `solver`, `db`, `mailer`) is injected into `createApp` so the whole system runs against fakes.

### 2.1 Components

| # | Module | Responsibility | Hard bound |
|---|---|---|---|
| 1 | `src/http/server.js`, `router.js` | node:http server, tiny router, JSON body, cookies, static files with ETag, security headers, `X-Request-Id` | body 4 KB (413), headersTimeout 10 s, requestTimeout 45 s, keepAlive 5 s, maxConnections 3000 |
| 2 | `src/auth/*` | scrypt passwords, signed session cookie + `tokenVersion`, API keys, email verify, password reset, onboarding gate, principal cache | scrypt 2 concurrent + 200 waiting → 503 |
| 3 | `src/admission.js` | The single decision point for a lookup request; emits exactly one response | see 3.1 |
| 4 | `src/store/batching.js` | `ReadBatcher` (point reads within 20 ms → one `$in`), `WriteCoalescer` (non-critical writes → one `bulkWrite` / 250 ms) | batcher 200 ids; coalescer 2000 ops, drops counters first, never job state |
| 5 | `src/queue.js` | In-memory two-lane queue (web, api), per-owner FIFO with owner rotation, web:api 2:1, EWMA drain rate, ETA | depth 1000; api 50 / web 3 queued per owner |
| 6 | `src/dispatcher.js` | Pull loop: slot free and circuit allows → pop → run → fan out → release. Never aborts mid-portal-call | concurrency = gate |
| 7 | `src/portal-gate.js` | The only path to the portal: adaptive semaphore (1→2), min gap 250 ms, per-minute bucket, hourly/daily hit budget, circuit breaker, state persisted to Mongo, keep-alive agent | see 3.3 |
| 8 | `src/runner.js` | Adapter over `lib/lookup.js` with lane-specific options; maps results to job outcomes | 3 images (api: one automatic re-queue → 6) |
| 9 | `src/solver-supervisor.js` | Owns one `OcrWorker`: pre-warm, restart with backoff, slot wait instead of "busy" throw, degraded mode, abstain-rate counter | 4 in flight (asserted ≥ concurrency max + 1) |
| 10 | `src/challenges.js` | In-memory CAPTCHA image + cookie pairs for web users; consume-before-POST | 300 entries, 100 s TTL, never persisted |
| 11 | `src/ledger.js` | `lookup_jobs` durable record; leaders inserted **before** any 202; boot recovery; history; help list | 24 h TTL |
| 12 | `src/gstin-cache.js` | L1 LRU + Mongo `gstin_cache`; fresh / stale-servable / negative | L1 5000 × 10 min; fresh 72 h; stale to 14 d; negative 24 h |
| 13 | `src/quota.js` | Per-owner token buckets (lookups, misses, cache reads, polls) + `usage_daily` (IST) | 60/min, 10 misses/min, 300/min, 300/min, 1000/day |
| 14 | `src/notifier.js` | Long-poll waiters; hold budget = 25 s − (now − arrivedAt) | 1500 waiters, beyond → immediate 202 |
| 15 | `src/mailer.js` | Mongo `email_outbox` + nodemailer; signup returns 201 before SMTP; retry schedule; operator alerts with cooldown | dead after schedule |
| 16 | `src/db.js` | One `MongoClient`, `ensureIndexes()` shared by prod and tests | pool 10, op timeout 2 s |
| 17 | `src/janitor.js` | Unref'd intervals: challenge expiry, queue deadlines, coalescer flush, outbox send, portal state flush, web-orphan cancel | — |
| 18 | `src/lifecycle.js`, `src/app.js` | Boot order, config validation, SIGTERM drain, health/admin endpoints, `createApp` | drain 10 s |
| 19 | `public/` | Vanilla HTML/CSS/JS, no build | — |
| 20 | `Dockerfile`, `docker-compose*.yml`, `Caddyfile` | Image, local stack (app + mongo + mailpit), prod stack (+ Caddy TLS) | app mem 900 MB |

### 2.2 Changes to the foundation (additive only; all 30 existing Node tests keep passing)
- `lib/gst-client.js` → `src/lib/gst-client.js`: `request()` and `GstClient` accept an optional `agent` (passed to `https.request`). Default unchanged.
- `lib/lookup.js` → `src/lib/lookup.js`: two options with defaults equal to current behaviour:
  - `manualFallback` (default `true`). `false`: after the final `INVALID_CAPTCHA` do **not** fetch another CAPTCHA; return `{ status:'needs_captcha', challenge:null, prediction:null, reason, attempts }`.
  - `solverErrorPolicy` (default `'manual'`). `'abstain'`: a solver throw is treated like an uncertain prediction (continue to the next image within `maxAttempts`) instead of returning `needs_captcha` immediately.
  - `clock` (optional `{ now, timeoutSignal }`) used for `started`/`elapsedMs` and the default `signal`. Default uses `Date.now` / `AbortSignal.timeout`.
- `lib/ocr-worker.js` → `src/lib/ocr-worker.js`: root path resolution updated for the new layout (`ocr/captcha_ocr.py`, `.venv` or `GST_PYTHON`). Behaviour unchanged.
- `captcha_ocr.py`, `captcha_preprocess.py`, `requirements.txt` → `ocr/`. Unchanged.
- `server.js` is deleted; replaced by `src/app.js`.

---

## 3. Behaviour

### 3.1 Admission (one lookup request)
Order is fixed; each step either responds or passes on. Nothing touches the portal here.

1. Parse body (4 KB cap) → `INVALID_INPUT` 400 / 413 / 415.
2. Normalise + validate GSTIN (regex + checksum, no network) → `INVALID_GSTIN` 400.
3. Principal gates: authenticated (401 `UNAUTHENTICATED`), `emailVerified` (403 `EMAIL_NOT_VERIFIED`), `onboarding.completedAt` (403 `ONBOARDING_INCOMPLETE`), key not revoked (403 `KEY_REVOKED`).
4. Per-owner bucket `lookup` 60/min → 429 `RATE_LIMITED`.
5. Daily quota (in-process view of `usage_daily`, refreshed ≤ 5 s) → 429 `QUOTA_EXCEEDED`, `Retry-After` = seconds to next IST midnight.
6. `fresh:true` requested: entry younger than 1 h → 400 `FRESH_TOO_SOON`; otherwise costs 3 miss tokens and skips cache read.
7. L1 result cache → hit: 200 (`X-Cache: HIT` or `STALE`).
8. Mongo `gstin_cache` via ReadBatcher → fresh: 200 `HIT`; stale (72 h–14 d): 200 `STALE` with `stale:true`; negative: 404 `GSTIN_NOT_FOUND`.
9. Coalescing map (`gstin → leaderJobId`): live leader exists → attach as follower (lane lifted to `web` if this request is web). Skip to 14 (a follower never inserts a leader; it gets its own doc only if it receives a 202).
10. Per-owner bucket `miss` 10/min → 429 `MISS_RATE_LIMITED` (body hint: use `GET /api/v1/gstin/{gstin}`).
11. Per-owner queued cap (api 50 / web 3) → 429 `QUEUED_LIMIT`. Depth ≥ 1000 → 503 `QUEUE_FULL` `{estimatedWaitSec}`.
12. Gate state: `open`/`half_open` with remaining pause ≤ 120 s → queue with pause-aware ETA; remaining > 120 s → 503 `PORTAL_UNAVAILABLE`; `budget` → 503 `PORTAL_BUDGET_EXHAUSTED`. Create leader job.
13. **Leader inserted synchronously** (batched `insertMany`, 50 ms window, awaited). Insert failure → 503 `DB_UNAVAILABLE` (never a 202 without a durable id).
14. Hold budget = `min(wait, 25 s) − (now − arrivedAt)`. If > 0 and waiters < 1500: park in Notifier. On result → 200 (`source: portal|coalesced`) or 404 `GSTIN_NOT_FOUND` or failed → error body. On budget expiry → convert to 202: followers get their own job doc inserted first (awaited), then `202 {status, jobId, position, estimatedWaitSec, pollAfterMs, expiresAt}`.

`GET /api/v1/lookups/{id}?wait=` follows the same hold rule against the job's state; bucket `poll` 300/min; ownership check → 404 `JOB_NOT_FOUND`.

### 3.2 Queue and dispatch
- Lanes `web`, `api`. Each lane: `ownerId → FIFO`, plus an owner rotation ring. `next()` alternates lanes 2:1 (web:api) and round-robins owners within a lane. Starvation is impossible; per-owner order is FIFO.
- Job lane = highest lane among leader and followers (a web follower lifts an api leader).
- EWMA drain rate (α 0.2), seeded 0.87/s at concurrency 1, 1.74/s at 2. ETA = `pauseRemaining + positionInEffectiveOrder / ewma`. `pollAfterMs = clamp(eta/4, 5 s, 60 s)`.
- `QUEUE_DEADLINE` 25 min → `QUEUE_TIMEOUT` (retryable, uncharged).
- Web orphan: web job with no poll for 45 s, no followers, depth > 50 % → cancelled (uncharged). API jobs are never cancelled for lack of polling.
- Dispatcher never aborts a job mid-portal-call. Api-lane jobs are dispatched only while the solver is `ready`.

### 3.3 PortalGate
- **Slot** held from `getCaptcha` start to `getDetails` end. Concurrency starts at `PORTAL_CONCURRENCY_START` (1), +1 after `PORTAL_RAMP_CLEAN_LOOKUPS` (50) consecutive clean lookups, up to `PORTAL_CONCURRENCY_MAX` (2); drops to 1 on any `ECONNRESET`/`TIMEOUT`. Learned value persisted; reset to 1 after any pause.
- **Spacing**: ≥ 250 ms between portal call starts (doubled to 500 ms for 30 s after a transport error). Token bucket 240 calls/min.
- **Budget**: 6000 hits/hour, 50 000 hits/day, persisted every 10 s and on every transition. At 100 % → state `budget`. Alert email at 80 % and 100 %.
- **Circuit**: 429 → `open` 60 s. First 403 → concurrency 1 + gap ×2 for 30 s. Second 403 within 60 s → `open` 600 s + alert. Third 403 within 1 h → `open` 1800 s + alert. 5 transport errors / 30 s → `open` 60 s. `INVALID_RESPONSE`/`MISSING_COOKIE` on the CAPTCHA GET (block page as 200) 2 / 60 s → `open` 600 s + alert. `INVALID_RESPONSE` on the details POST 5 consecutive → `open` 300 s + alert (schema drift). Consecutive trips double the cooldown, cap 1 h.
- **Half-open probe**: one bare CAPTCHA GET + OCR, no POST, no customer job. Success → `closed` at concurrency 1.
- **Manual submit priority**: web CAPTCHA submits jump the wait list; pre-emptive 410 `CHALLENGE_EXPIRED` if the expected wait exceeds the cookie's remaining life.
- `https.Agent({ keepAlive: true, maxSockets: PORTAL_CONCURRENCY_MAX + 1 })`. User-Agent stays `GST-Lookup/1.0`.
- Every transition appended to capped `portal_events`; state read from `portal_state` before the dispatcher starts.

### 3.4 Runner outcome mapping (per job)
| lookup.js result / error | Outcome |
|---|---|
| `success` | `completed` → cache.set, quota.charge(lookups+portalLookups; followers charged `lookups`), notify all |
| `INVALID_GSTIN` (SWEB_9035) | cache.setNegative → `failed GSTIN_NOT_FOUND` (not retryable), notify 404 |
| `needs_captcha`, job has a web subscriber | `awaiting_captcha`: challenges.put → offered to the earliest web subscriber; others poll `assignedToYou:false`. Expiry unsubmitted → `failed CAPTCHA_UNSOLVED` for all (v1 simplification) |
| `needs_captcha`, api-only | `attempts < 2` → re-queue at back (uncharged); else `failed CAPTCHA_UNSOLVED` (retryable, `retryAfterSec` 30, uncharged) and listed under "Needs your help" |
| `RATE_LIMITED` / `ACCESS_DENIED` | gate.reportOutcome; re-queue at head (cookie spent, never replayed) |
| transport error after retries / `LOOKUP_TIMEOUT` | `failed LOOKUP_TIMEOUT` (retryable, uncharged) |
| other `GstError` | `failed PORTAL_ERROR` (retryable false for `INVALID_RESPONSE`; nothing cached) |

Web-lane jobs run lookup.js with defaults. Api-lane jobs run with `{ manualFallback:false, solverErrorPolicy:'abstain' }`.

### 3.5 Solver supervision
- Pre-warm at boot (non-blocking). `solve()` waits for one of 4 slots instead of throwing "busy".
- Worker death: restart with backoff 1, 2, 4 … 30 s; the affected image is retried once after restart (cookie still valid ~110 s).
- 3 failures / 2 min → `degraded` for 60 s: web jobs manual-only, api jobs held in queue with zero portal calls.
- Abstain rate over the last 50 images > 50 % → api jobs fast-fail after 1 image, web straight to manual, alert email. Auto-recovers.
- Boot assertion: `PORTAL_CONCURRENCY_MAX + 1 ≤ OCR_MAX_INFLIGHT` (4), else refuse to start.

### 3.6 Shutdown and recovery
- SIGTERM: `/health/ready` → 503; new requests get 503 + `Connection: close`; running lookups (≤ 2) get 10 s; long-poll waiters answered 202 (their job ids are durable); coalescer flushed; exit.
- Boot: config validate → Mongo connect → `ensureIndexes` → read `portal_state` (honour `pausedUntil`, learned concurrency) → ledger recovery (`queued|running|awaiting_captcha` younger than 25 min in `_id` order; running/awaiting → queued; older → `QUEUE_TIMEOUT`) → solver pre-warm (parallel) → listen.
- Manual challenges do not survive restart: submit → 410 `CHALLENGE_EXPIRED`, UI offers "Get new image".

---

## 4. Interfaces (normative)

All modules are CommonJS, `'use strict'`. All async errors are `GstError`-shaped where client-visible: `new AppError(code, message, { status, retryable, retryAfterSec })`. `AppError extends Error { code, status, retryable, retryAfterSec }` lives in `src/errors.js`. `GstError` from `gst-client.js` is mapped to `AppError` at the runner/HTTP boundary via `src/errors.js` `fromGstError(err)`.

### 4.1 Clock
```js
// src/clock.js
realClock() → { now(): number, setTimeout(fn, ms): handle, clearTimeout(handle), timeoutSignal(ms): AbortSignal, setInterval(fn, ms): handle, clearInterval(handle) }
// test/fixtures/clock.js
fakeClock(start = 0) → same shape + advance(ms): Promise<void> (runs due timers in order, awaits microtasks), pending(): number
```
Every module receives `clock` and never calls `Date.now`, `setTimeout`, or `AbortSignal.timeout` directly.

### 4.2 Config
```js
// src/config.js
loadConfig(env = process.env) → Config   // applies defaults, coerces numbers/booleans, validates; throws Error with all problems joined when invalid
Config = { port, bindHost, publicUrl, trustProxy, isProd (publicUrl startsWith https), mongo:{url,maxPool,opTimeoutMs}, session:{secret,ttlMs}, scrypt:{N,concurrency}, portal:{concurrencyStart,concurrencyMax,rampCleanLookups,minGapMs,maxPerMinute,maxHitsPerHour,maxHitsPerDay,budgetAlertFraction,timeoutMs,keepAlive}, circuit:{cooldown429Ms,cooldown403Ms,cooldown403RepeatMs,maxMs,trip403Count,tripTransportErrors,tripBlockPageCount,tripSchemaCount,queueWhilePausedMaxMs}, queue:{maxDepth,maxPerOwnerApi,maxPerOwnerWeb,deadlineMs,webOrphanMs,laneWeightWeb}, lookup:{abortMs,maxAttempts,autoRetryUnsolved,minScore}, ocr:{timeoutMs,startupTimeoutMs,maxInflight,degradedMs,abstainWindow,abstainAlertRate,python}, challenge:{ttlMs,maxPending}, cache:{freshMs,ttlMs,negativeTtlMs,l1Entries,l1TtlMs,freshMinAgeMs}, rate:{lookupsPerMin,missesPerMin,cacheReadsPerMin,pollsPerMin,quotaPerDay,loginPerIpPerMin,loginPerEmail15Min,signupPerIpPerHour}, http:{maxWaitSec,requestTimeoutMs,headersTimeoutMs,keepAliveTimeoutMs,maxConnections,bodyLimit,maxLongpollWaiters}, batching:{readWindowMs,readMax,writeFlushMs,writeFlushOps,writeBufferMax,insertWindowMs}, principalCache:{ttlMs,entries,degradedGraceMs}, smtp:{host,port,user,pass,from}|null, adminEmail, adminToken, requireEmailVerify, alertCooldownMs, shutdownGraceMs, portalStub, logLevel }
```
Required when `isProd`: `SESSION_SECRET`, `ADMIN_TOKEN`, `ADMIN_EMAIL`, `SMTP_*`. Dev: ephemeral secret with a warning.

### 4.3 Errors and HTTP results
```js
// src/errors.js
class AppError extends Error { constructor(code, message, { status = 500, retryable = false, retryAfterSec } = {}) }
fromGstError(err) → AppError           // maps gst-client codes (see §5)
errorBody(err, requestId) → { error:{ code, message, retryable, retryAfterSec? }, requestId }
// HttpResult used by admission/handlers
{ status: number, body: object|Buffer|null, headers?: Record<string,string> }
```

### 4.4 HTTP layer
```js
// src/http/router.js
createRouter() → { add(method, pattern, handler), match(method, pathname) → { handler, params } | null }
// pattern: '/api/v1/lookups/:id' ; handler(ctx) → Promise<HttpResult> ; ctx = { req, res, params, query, requestId, arrivedAt, principal?, body? }
// src/http/server.js
createHttpServer({ config, clock, router, staticDir, authenticate, log }) → http.Server
readJson(req, limitBytes) → Promise<object>          // throws AppError INVALID_INPUT(400) / PAYLOAD_TOO_LARGE(413) / UNSUPPORTED_MEDIA(415)
sendJson(res, status, body, headers = {})
parseCookies(req) → Record<string,string>
setSecurityHeaders(res, config)
// Server sets: X-Request-Id, Cache-Control no-store (dynamic), CSP, X-Content-Type-Options; honours X-Forwarded-Proto/For only when config.trustProxy
// Static: GET /, /*.html, /*.css, /*.js from staticDir with ETag + Cache-Control: public, max-age=300
```

### 4.5 Auth
```js
// src/auth/password.js
new PasswordHasher({ N, concurrency, maxWaiting = 200 })
  .hash(password) → Promise<{ hash: string(base64), salt: string(base64) }>   // 503 SCRYPT_BUSY when queue full
  .verify(password, hash, salt) → Promise<boolean>
// src/auth/session.js
signSession({ userId, tokenVersion, exp }, secret) → string        // base64url(payload).base64url(hmac-sha256)
verifySession(cookieValue, secret, now) → { userId, tokenVersion, exp } | null
sessionCookie(value, { secure, maxAgeSec }) → string (Set-Cookie header value; name gsb_sid; HttpOnly; SameSite=Lax; Path=/)
// src/auth/apikeys.js
generateApiKey() → { key: 'gsb_live_' + 32 base62, prefix: first 12 chars, hash: sha256hex(key) }
hashApiKey(key) → sha256hex
// src/auth/principal.js
new PrincipalResolver({ db, batcher, clock, config })
  .fromRequest(req) → Promise<Principal | null>   // Bearer → api_keys(hash) → users ; cookie → verifySession → users(tokenVersion match)
  Principal = { kind:'session'|'apikey', userId: string, keyId: string|null, ownerId: string (= userId), user: { email, emailVerified, onboardingComplete, tokenVersion, limits? } }
  // PrincipalCache LRU 2000 × 60 s; extended to degradedGraceMs while Mongo is unreachable
// src/auth/routes.js
registerAuthRoutes(router, deps) // deps = { users(store), hasher, mailer, config, clock, rateLimiter, log }
// src/auth/users.js  (Mongo store)
new UsersStore({ db, batcher, coalescer })
  .create({ email, passwordHash, passwordSalt, name }) → Promise<user>   // 409 EMAIL_EXISTS
  .findByEmail(email), .findById(id), .setVerifyToken(id, hash, expiresAt), .verifyByToken(hash, now) → user|null, .setResetToken, .resetByToken(hash, now, newHash, newSalt) → user|null, .bumpTokenVersion(id), .completeOnboarding(id, { name, company, purpose, expectedVolume }), .touchLogin(id)
// src/auth/keys.js
new ApiKeysStore({ db, batcher, coalescer })
  .create(userId, name) → Promise<{ id, key, prefix }>   // 409 KEY_LIMIT at 5 active
  .list(userId) → Promise<[{ id, prefix, name, createdAt, lastUsedAt }]>
  .revoke(userId, id) → Promise<boolean>
  .findByHash(hash) → Promise<key|null>   // batched
  .touchUsed(id)   // coalesced, ≤ 1 write / 60 s / key
```
Cookie-authenticated mutations require `Origin` equal to `PUBLIC_URL` origin **and** header `X-Requested-With: gstin-by-sandbee` → else 403 `CSRF_REJECTED`.

### 4.6 Rate limiting (in-process)
```js
// src/rate-limiter.js
new RateLimiter({ clock })
  .take(key, { limit, windowMs, cost = 1 }) → { ok: boolean, remaining: number, resetInSec: number }   // sliding window counters, LRU-bounded 50 000 keys
```
Used for per-owner buckets (`lookup`, `miss`, `cacheRead`, `poll`) and per-IP/per-email auth limits. Headers `X-RateLimit-Limit/-Remaining/-Reset` from the `lookup` bucket.

### 4.7 Storage helpers
```js
// src/db.js
connectMongo(config, log) → Promise<{ client, db }>
ensureIndexes(db) → Promise<void>       // idempotent; the only place indexes are defined (§6)
// src/store/batching.js
new ReadBatcher({ collection, clock, windowMs, max }) .get(id) → Promise<doc|null>   // groups ids arriving within windowMs into one find({_id:{$in}})
new WriteCoalescer({ db, clock, flushMs, flushOps, max, log })
  .add(collectionName, op, { priority = 'normal'|'low' } = {})   // op = bulkWrite operation object; 'low' dropped first on overflow
  .flush() → Promise<void>, .pending() → number, .dropped() → number, .start(), .stop() → Promise<void> (final flush)
// src/ulid.js
ulid(now = Date.now()) → string (26 chars, Crockford base32, time-ordered, monotonic within a ms)
```

### 4.8 Cache, quota, ledger
```js
// src/gstin-cache.js
new GstinCache({ db, clock, coalescer, config, log })
  .get(gstin) → Promise<CacheEntry | null>     // L1 then batched Mongo read
  CacheEntry = { gstin, details|null, negative: boolean, code?: 'GSTIN_NOT_FOUND', fetchedAt: number, stale: boolean, expired: boolean }
  .set(gstin, details, now) ; .setNegative(gstin, now) ; .invalidate(gstin)
  .isFresh(entry, now), .isServable(entry, now)
// src/quota.js
new Quota({ db, clock, coalescer, limiter, config })
  .check(ownerId, kind, { cost = 1 } = {}) → { ok, code?, retryAfterSec?, remaining, limit, resetInSec }   // kind ∈ lookup|miss|cacheRead|poll|daily
  .charge(ownerId, { lookups = 0, cacheHits = 0, portalLookups = 0, coalesced = 0, failed = 0, unsolved = 0 })   // coalesced $inc on usage_daily(_id ownerId:YYYYMMDD IST)
  .usageToday(ownerId) → Promise<{ lookups, cacheHits, portalLookups, coalesced, failed, unsolved }>
  istDayKey(now) → 'YYYYMMDD'
// src/ledger.js
new JobLedger({ db, clock, coalescer, config, log })
  .insertLeaders(jobs) → Promise<void>          // awaited insertMany within insertWindowMs; active:true
  .insertFollowers(jobs) → Promise<void>        // awaited; leaderId set
  .update(jobId, patch, { critical = false } = {}) → Promise<void>|void   // critical → awaited updateOne; else coalesced
  .finish(jobId, { state, code, source, finishedAt, elapsedMs }) // sets active:false via coalescer
  .recover(now, deadlineMs) → Promise<JobDoc[]>
  .history(ownerId, { limit = 50, cursor }) → Promise<{ items, nextCursor }>
  .helpList(ownerId, now) → Promise<[{ jobId, gstin, keyPrefix, failedAt }]>
  .get(jobId) → Promise<JobDoc|null>
```

### 4.9 Queue, notifier, challenges
```js
// src/queue.js
Job = { id, gstin, ownerId, keyId, lane:'web'|'api', state, createdAt, arrivedAt, attempts, humanOffers, followers: Map<jobId, { ownerId, lane, keyId }>, leaderId: null, lastInterestAt, priorityHead: boolean }
new LookupQueue({ clock, config })
  .enqueue(job, { head = false } = {}) → { ok: true, position } | { ok: false, code: 'QUEUE_FULL'|'QUEUED_LIMIT', estimatedWaitSec }
  .next() → Job | null ; .peekDepth() → { total, web, api } ; .position(jobId) → number ; .eta(jobId, pauseRemainingMs) → seconds ; .pollAfterMs(etaSec) → number
  .get(jobId), .remove(jobId) → Job|null, .touch(jobId, now), .liftLane(jobId, lane), .recordCompletion(elapsedMs), .drainRate() → per second, .setConcurrency(n)
  .expired(now) → Job[] (deadline) ; .orphans(now) → Job[] (web, no followers, stale poll, depth > 50 %)
  .byOwnerCount(ownerId, lane) → number
// src/notifier.js
new Notifier({ clock, config })
  .hold(jobId, budgetMs, onClose) → Promise<Result | null>   // null on budget expiry; onClose lets the HTTP layer detach on socket close
  .resolve(jobId, result) ; .resolveAll(followerIds, result) ; .count() → number ; .drainAll(makeResult) (SIGTERM)
// src/challenges.js
new ChallengeStore({ clock, config })
  .put({ jobId, ownerId, gstin, challenge, suggestion, reason }) → { challengeId, expiresAt }
  .peek(challengeId, ownerId) → entry|null ; .consume(challengeId, ownerId) → entry|null ; .byJob(jobId) → entry|null ; .expire(now) → number ; .size()
  // entry = { challengeId, jobId, ownerId, gstin, challenge:{buffer,mime,cookie,createdAt}, suggestion, reason, expiresAt, consumed:boolean }
```

### 4.10 Gate, supervisor, runner, dispatcher, admission
```js
// src/portal-gate.js
new PortalGate({ clock, config, stateStore, events, alert, log })
  // stateStore = { load() → Promise<state|null>, save(state) → Promise<void> } over portal_state ; events = { append(evt) } over portal_events
  .init() → Promise<void>                  // load persisted state
  .wrap(client) → { getCaptcha(opts), getDetails(gstin, captcha, challenge, opts) }   // enforces min gap + per-minute bucket + budget counting per HTTP call; classifies errors
  .acquire(signal) → Promise<release: () => void>   // waits for a slot AND circuit closed/half_open ; rejects AppError PORTAL_UNAVAILABLE / PORTAL_BUDGET_EXHAUSTED when it cannot admit within signal
  .canQueue(now) → { ok: true, pauseRemainingMs } | { ok: false, code, retryAfterSec }
  .reportLookup({ ok, code, transport: boolean, side: 'get'|'post'|null }) // ramp / drop / trip logic
  .state(now) → { circuit:'closed'|'open'|'half_open'|'budget', pausedUntil, pauseReason, concurrency, inFlight, hitsHour, hitsDay, budgetHour, budgetDay, drainSeed, consecutiveTrips }
  .probe(fn) → Promise<boolean>            // half-open: runs fn (bare GET+OCR) once
  .pause(ms, reason) / .resume()          // admin
  .agent → https.Agent
// src/solver-supervisor.js
new SolverSupervisor({ workerFactory: () => OcrWorker, clock, config, alert, log })
  .start() → Promise<void> (non-blocking warm) ; .solve(buffer) → Promise<prediction> ; .state() → { status:'starting'|'ready'|'degraded'|'down', restarts, abstainRate, inFlight } ; .recordAbstain(bool) ; .close()
// src/runner.js
runJob(job, { client(gated), solver, clock, config, lane }) → Promise<Outcome>
  Outcome = { kind:'completed', details, attempts, elapsedMs, ocrMs } | { kind:'not_found' } | { kind:'needs_captcha', challenge, prediction, reason, attempts } | { kind:'unsolved' } | { kind:'requeue', head: boolean, reason } | { kind:'failed', code, retryable, message }
// src/dispatcher.js
new Dispatcher({ queue, gate, runner, solver, cache, ledger, quota, notifier, challenges, clock, config, log, alert })
  .start() ; .stop() → Promise<void> (waits ≤ shutdownGraceMs for running jobs) ; .running() → number
  .fanOut(job, outcome)   // internal; documented for tests: writes cache, ledger, quota, notifier for leader + followers; deletes the coalescing entry for job.gstin; releases the gate slot
// src/admission.js
new Admission({ cache, queue, ledger, gate, quota, notifier, coalescing: Map, challenges, clock, config, log })
  .lookup({ principal, gstin, wait, fresh, arrivedAt, lane, requestId, onClose }) → Promise<HttpResult>
  .poll({ principal, jobId, wait, arrivedAt, onClose }) → Promise<HttpResult>
  .cancel({ principal, jobId }) → Promise<HttpResult>
  .cacheOnly({ principal, gstin }) → Promise<HttpResult>
  .submitCaptcha({ principal, jobId, challengeId, digits }) → Promise<HttpResult>   // web only; priority lane
  .refreshCaptcha({ principal, jobId }) → Promise<HttpResult>
  .help({ principal }) / .solveHelp({ principal, jobId })
```

### 4.11 Mailer, app
```js
// src/mailer.js
new EmailOutbox({ db, clock, config, transport, log })   // transport = nodemailer transport or fake { sendMail(msg) → Promise }
  .enqueue({ to, template:'verify'|'reset'|'alert', vars }) → Promise<void>   // inserts pending row; returns before SMTP
  .processDue(now) → Promise<{ sent, failed, dead }>
  .alert(type, vars) → Promise<void>          // to adminEmail with alertCooldownMs per type
  templates: render(template, vars) → { subject, text, html }
// src/app.js
createApp({ config, clock = realClock(), client, solver, db, mailTransport, log }) → Promise<App>
  App = { server: http.Server, start() → Promise<void> (listen), stop() → Promise<void> (drain), components: { gate, queue, dispatcher, cache, ledger, quota, notifier, challenges, supervisor, outbox, admission, principals } }
  // PORTAL_STUB=fixtures → client/solver from test/fixtures (fake-portal, fake-solver) when not injected
```

---

## 5. Error codes (canonical)

| Code | HTTP | retryable | Source |
|---|---|---|---|
| INVALID_INPUT | 400 | no | body/shape |
| INVALID_GSTIN | 400 | no | checksum/regex |
| FRESH_TOO_SOON | 400 | no | `fresh:true` on < 1 h entry |
| PAYLOAD_TOO_LARGE | 413 | no | > 4 KB |
| UNSUPPORTED_MEDIA | 415 | no | non-JSON |
| UNAUTHENTICATED | 401 | no | |
| INVALID_CREDENTIALS | 401 | no | login |
| EMAIL_NOT_VERIFIED | 403 | no | |
| ONBOARDING_INCOMPLETE | 403 | no | |
| KEY_REVOKED | 403 | no | |
| CSRF_REJECTED | 403 | no | Origin / X-Requested-With |
| NOT_FOUND | 404 | no | route |
| JOB_NOT_FOUND | 404 | no | not owner or > 24 h |
| GSTIN_NOT_FOUND | 404 | no | SWEB_9035 (negative cached 24 h) |
| NOT_CACHED | 404 | no | cache-only endpoint |
| EMAIL_EXISTS | 409 | no | |
| KEY_LIMIT | 409 | no | 5 active |
| CHALLENGE_CONSUMED | 409 | no | double submit |
| JOB_NOT_CANCELLABLE | 409 | no | |
| CHALLENGE_EXPIRED | 410 | yes | TTL, restart, pre-emptive |
| TOKEN_INVALID | 400 | no | verify/reset |
| TOKEN_EXPIRED | 410 | no | verify/reset |
| RATE_LIMITED | 429 | yes | 60/min |
| MISS_RATE_LIMITED | 429 | yes | 10 new jobs/min |
| QUEUED_LIMIT | 429 | yes | 50 api / 3 web |
| QUOTA_EXCEEDED | 429 | yes | 1000/day IST |
| SCRYPT_BUSY | 503 | yes | login flood |
| QUEUE_FULL | 503 | yes | depth 1000 |
| PORTAL_UNAVAILABLE | 503 | yes | circuit open > 120 s, 403 block |
| PORTAL_BUDGET_EXHAUSTED | 503 | yes | hour/day budget |
| OCR_UNAVAILABLE | 503 | yes | api lane, solver degraded past deadline |
| DB_UNAVAILABLE | 503 | yes | insert failed / principal unverifiable |
| CAPTCHA_UNSOLVED | (job failed) | yes (30 s) | api-only, 6 images abstained |
| QUEUE_TIMEOUT | (job failed) | yes | 25 min |
| LOOKUP_TIMEOUT | (job failed) | yes | 60 s abort / transport |
| PORTAL_ERROR | (job failed) | varies | other portal errors |

The runner intercepts `INVALID_CAPTCHA`, `RATE_LIMITED` and `ACCESS_DENIED` before mapping (§3.4). For everything that reaches a client, `fromGstError`: `INVALID_GSTIN→INVALID_GSTIN(400)`, `INVALID_CAPTCHA→(runner internal)`, `RATE_LIMITED→PORTAL_UNAVAILABLE(503)`, `ACCESS_DENIED→PORTAL_UNAVAILABLE(503)`, `TIMEOUT/ECONNRESET/ETIMEDOUT/EAI_AGAIN→LOOKUP_TIMEOUT`, `INVALID_RESPONSE/MISSING_COOKIE/RESPONSE_TOO_LARGE/HTTP_ERROR→PORTAL_ERROR(502)`, `LOOKUP_TIMEOUT→LOOKUP_TIMEOUT(504)`.

---

## 6. Storage

Database `gstin_sandbee`. Official `mongodb` driver. `ensureIndexes()` defines exactly these:

| Collection | Document (approx bytes) | Indexes |
|---|---|---|
| `users` (~500) | `{_id, email, passwordHash, passwordSalt, emailVerified, verify:{tokenHash,expiresAt}|null, reset:{tokenHash,expiresAt}|null, tokenVersion, onboarding:{name,company,purpose,expectedVolume,completedAt}|null, plan:'free', limits?, createdAt, lastLoginAt}` | `{email:1}` unique; `{'verify.tokenHash':1}` sparse; `{'reset.tokenHash':1}` sparse |
| `api_keys` (~260) | `{_id, userId, keyHash, prefix, name, createdAt, lastUsedAt, revokedAt|null}` | `{keyHash:1}` unique; `{userId:1, createdAt:-1}` |
| `gstin_cache` (~740) | `{_id: gstin, details|null, negative, code?, fetchedAt, lastHitAt, hits, expiresAt}` | `{expiresAt:1}` expireAfterSeconds 0 |
| `lookup_jobs` (~380) | `{_id: ulid, gstin, ownerId, keyId|null, lane, state, code|null, source|null, leaderId|null, active?, attempts, humanOffers, createdAt, startedAt, finishedAt, waitMs, elapsedMs}` (no details) | `{createdAt:1}` expireAfterSeconds 86400; `{ownerId:1,_id:-1}`; `{gstin:1}` unique partial `{active:true}`; `{state:1,_id:1}` partial `{state:{$in:['queued','running','awaiting_captcha']}}` |
| `usage_daily` (~140) | `{_id:'ownerId:YYYYMMDD', ownerId, day, lookups, cacheHits, portalLookups, coalesced, failed, unsolved}` | `{day:1}` expireAfterSeconds 35·86400 |
| `email_outbox` (~600) | `{_id, to, template, vars, state:'pending'|'sent'|'dead', attempts, nextAttemptAt, lastError, createdAt, sentAt}` | `{state:1,nextAttemptAt:1}`; `{createdAt:1}` expireAfterSeconds 7·86400 |
| `portal_state` (1 doc) | `{_id:'portal', circuit, pausedUntil, pauseReason, consecutiveTrips, concurrency, hits:{hour,hourCount,day,dayCount}, updatedAt}` | — |
| `portal_events` (capped 262144 B) | `{at, type, concurrency, gapMs, hitsThisHour}` | capped |

Never stored: CAPTCHA images, cookies, raw portal bodies, plaintext API keys, plaintext session ids.
Fit (typical: 20k users, 40k keys, 200k cached GSTINs, 50k jobs/day) ≈ 222 MB logical. `/admin/health` reports `db.stats()` `dataSize+indexSize`.

---

## 7. HTTP API

Conventions: JSON; `X-Request-Id` on every response; errors `{error:{code,message,retryable,retryAfterSec?},requestId}` with `Retry-After` on 429/503/410; lookups carry `X-Cache: HIT|STALE|MISS|COALESCED`, `X-RateLimit-*`, `X-Quota-Remaining`. Auth: `/api/v1/*` accepts `Authorization: Bearer gsb_live_…` or the web cookie; `/auth/*`, `/web/*`, `/me`, `/keys` cookie only.

### Auth & account (cookie)
| Route | Body → Response |
|---|---|
| `POST /auth/signup` | `{email, password≥10, name}` → 201 `{userId, verificationSent:true}` · 400 · 409 EMAIL_EXISTS · 429 (10/h/IP) |
| `GET /auth/verify?token=` | → 302 `/onboarding.html` + Set-Cookie · 400 TOKEN_INVALID · 410 TOKEN_EXPIRED |
| `POST /auth/resend` | `{email}` → 202 always (3/h/email) |
| `POST /auth/login` | `{email,password}` → 200 `{user}` + Set-Cookie · 401 · 403 EMAIL_NOT_VERIFIED · 429 · 503 SCRYPT_BUSY |
| `POST /auth/logout` / `/auth/logout-all` | → 204 (logout-all bumps tokenVersion) |
| `POST /auth/forgot` | `{email}` → 202 always |
| `POST /auth/reset` | `{token,password}` → 200 `{ok:true}` (bumps tokenVersion) · 400 · 410 |
| `POST /auth/onboarding` | `{name,company,purpose,expectedVolume}` → 200 `{user}` |
| `GET /me` | → 200 `{user, plan, limits, usageToday, portal:{state}}` |
| `GET /keys` · `POST /keys {name}` · `DELETE /keys/:id` | 200 list · 201 `{id,key(once),prefix}` / 409 KEY_LIMIT · 204 |

### Lookups (cookie or API key; verified + onboarded)
| Route | Response |
|---|---|
| `POST /api/v1/lookups {gstin, fresh?, wait?:0–25}` | 200 `{status:'completed', gstin, source, stale, fetchedAt, details}` · 202 `{status:'queued'|'running'|'awaiting_captcha', jobId, gstin, position, estimatedWaitSec, pollAfterMs, expiresAt, links:{self}}` · 400 · 401/403 · 404 GSTIN_NOT_FOUND · 429 · 503 |
| `GET /api/v1/lookups/:jobId?wait=0–25` | 200 `{status, gstin, createdAt, position?, estimatedWaitSec?, pollAfterMs, portal?:{paused,resumeInSec}, details?, error?}`; web sessions on `awaiting_captcha` also get `{challengeId, image:'data:…', suggestion, expiresAt, reason, assignedToYou}` · 404 JOB_NOT_FOUND |
| `DELETE /api/v1/lookups/:jobId` | 204 · 409 JOB_NOT_CANCELLABLE |
| `GET /api/v1/lookups?limit=50&cursor=` | 200 `{items:[{jobId,gstin,state,source,code?,createdAt,finishedAt}], nextCursor}` |
| `GET /api/v1/gstin/:gstin` | cache-only, never portal, quota-free: 200 `{source:'cache', stale, fetchedAt, details}` · 404 NOT_CACHED · 404 GSTIN_NOT_FOUND · 400 |

`details = { gstin, status, legalName, tradeName, companyType, taxpayerType, registrationDate, cancellationDate, businessNature, address, stateJurisdiction, centreJurisdiction }` (exactly what `gst-client.js` returns).

### Web-only (cookie)
| Route | Response |
|---|---|
| `POST /web/lookups/:jobId/captcha {challengeId, digits}` | 200 `{status:'completed', details}` · 200 `{status:'awaiting_captcha', …fresh image, reason:'rejected'}` (max 3 refreshes/job) · 409 CHALLENGE_CONSUMED · 410 CHALLENGE_EXPIRED · 503 |
| `POST /web/lookups/:jobId/refresh-captcha` | 200 awaiting_captcha with fresh image |
| `GET /web/help` | 200 `[{jobId, gstin, keyPrefix, failedAt}]` (api jobs ended CAPTCHA_UNSOLVED in 24 h, not yet cached) |
| `POST /web/help/:jobId/solve` | 202 `{jobId}` — new web-lane job for that GSTIN |

### Ops
| Route | |
|---|---|
| `GET /health/live` | 200 while running |
| `GET /health/ready` | 200 when not draining and Mongo reachable (or within degraded grace), else 503 |
| `GET /admin/health` (`X-Admin-Token`) | `{status, mongo, ocr, portal, queue, challenges, waiters, writeBuffer, storage:{dataMb,indexMb}, outbox}` |
| `GET /admin/metrics` | counters: responses by code, cache hit ratio, coalesce ratio, lookup p50/p90, event-loop lag p99 |
| `POST /admin/portal/pause {seconds}` · `POST /admin/portal/resume` | 200, persisted |

---

## 8. Frontend (`public/`, vanilla, no build)

Shared: `style.css` (current green palette `#165e49`, Inter, existing card/input/button styles), `common.js` (fetch wrapper adding `X-Requested-With`, error toast, session check, redirect helpers). Brand: **GSTIN by Sandbee**.

| Page | Purpose |
|---|---|
| `index.html` | Landing: what it does, honest "how fast" note, CTA signup/login, link to docs |
| `signup.html`, `login.html`, `verify.html` (resend), `forgot.html`, `reset.html` | Auth flows; inline validation; error codes mapped to friendly copy |
| `onboarding.html` | name, company, purpose (select), expected volume (select) → dashboard |
| `app.html` | Dashboard: lookup box → result card (instant) / queued panel (position, countdown, auto-poll) / **manual CAPTCHA modal** (image, suggestion prefilled, expiry countdown, New image, submit) / stale badge; history table; API keys (create → one-time reveal, revoke); usage bar (today vs 1000); "Needs your help" list with Solve button; portal status pill (normal / paused) |
| `docs.html` | API reference generated from §7 with curl examples, error table, polling guidance, cache-only fast path |

Behaviours: poll at `pollAfterMs`; stop polling on terminal state; on 410 show "Get new image"; on 429/503 show `Retry-After` countdown; JSON download of result kept from the current UI. Mobile: no horizontal scroll at 390 px.

---

## 9. Docker & ops

- `Dockerfile`: `node:22-bookworm-slim`; `apt install python3 python3-venv`; `/opt/venv` with `ocr/requirements.txt`; `npm ci --omit=dev`; `ENV GST_PYTHON=/opt/venv/bin/python NODE_OPTIONS=--max-old-space-size=384`; non-root user; `HEALTHCHECK` on `/health/live`; `CMD node src/index.js`.
- `docker-compose.yml` (local): `app` (ports 3000, env from `.env`, `mem_limit: 900m`, `stop_grace_period: 15s`, depends on mongo), `mongo:8` (volume), `mailpit` (1025 SMTP, 8025 UI). `.env.example` points SMTP at mailpit and sets `REQUIRE_EMAIL_VERIFY=true`.
- `docker-compose.prod.yml`: `app` + `caddy` (`Caddyfile`: `{$PUBLIC_HOST}` reverse_proxy app:3000, automatic HTTPS) ; `TRUST_PROXY=true`; Mongo omitted (Atlas via `MONGO_URL`) or included behind a profile.
- `.dockerignore`: node_modules, .venv, test-results, legacy, docs, *.md except README.
- Logs: JSON lines to stdout; never cookies, portal bodies, keys.

---

## 10. Configuration (env → `loadConfig`)

Defaults as listed; all overridable.

`PORT=3000` `BIND_HOST=0.0.0.0` `PUBLIC_URL=http://localhost:3000` `TRUST_PROXY=false` `MONGO_URL=mongodb://mongo:27017/gstin_sandbee` `MONGO_MAX_POOL=10` `MONGO_OP_TIMEOUT_MS=2000` `MONGO_DEGRADED_GRACE_MS=600000` `READ_BATCH_WINDOW_MS=20` `READ_BATCH_MAX=200` `WRITE_FLUSH_MS=250` `WRITE_FLUSH_OPS=200` `WRITE_BUFFER_MAX=2000` `INSERT_BATCH_WINDOW_MS=50` `PORTAL_CONCURRENCY_START=1` `PORTAL_CONCURRENCY_MAX=2` `PORTAL_RAMP_CLEAN_LOOKUPS=50` `PORTAL_MIN_GAP_MS=250` `PORTAL_MAX_PER_MINUTE=240` `PORTAL_MAX_HITS_PER_HOUR=6000` `PORTAL_MAX_HITS_PER_DAY=50000` `PORTAL_BUDGET_ALERT_FRACTION=0.8` `PORTAL_TIMEOUT_MS=15000` `PORTAL_KEEPALIVE=true` `CIRCUIT_COOLDOWN_429_MS=60000` `CIRCUIT_COOLDOWN_403_MS=600000` `CIRCUIT_COOLDOWN_403_REPEAT_MS=1800000` `CIRCUIT_COOLDOWN_MAX_MS=3600000` `CIRCUIT_TRIP_403_COUNT=2` `CIRCUIT_TRIP_TRANSPORT_ERRORS=5` `CIRCUIT_TRIP_BLOCKPAGE_COUNT=2` `CIRCUIT_TRIP_SCHEMA_COUNT=5` `QUEUE_WHILE_PAUSED_MAX_S=120` `MAX_QUEUE_DEPTH=1000` `MAX_QUEUED_PER_OWNER_API=50` `MAX_QUEUED_PER_OWNER_WEB=3` `LANE_WEIGHT_WEB=2` `QUEUE_DEADLINE_MS=1500000` `WEB_ORPHAN_CANCEL_MS=45000` `LOOKUP_ABORT_MS=60000` `LOOKUP_MAX_ATTEMPTS=3` `AUTO_RETRY_UNSOLVED=1` `OCR_MIN_SCORE=0.8` `OCR_TIMEOUT_MS=10000` `OCR_STARTUP_TIMEOUT_MS=30000` `OCR_MAX_INFLIGHT=4` `OCR_DEGRADED_MS=60000` `OCR_ABSTAIN_WINDOW=50` `OCR_ABSTAIN_ALERT_RATE=0.5` `CHALLENGE_TTL_MS=100000` `MAX_PENDING_CHALLENGES=300` `CACHE_FRESH_HOURS=72` `CACHE_TTL_DAYS=14` `NEGATIVE_CACHE_TTL_HOURS=24` `CACHE_L1_ENTRIES=5000` `CACHE_L1_TTL_MS=600000` `FRESH_MIN_AGE_MS=3600000` `RATE_LOOKUPS_PER_MINUTE=60` `RATE_MISSES_PER_MINUTE=10` `RATE_CACHE_READS_PER_MINUTE=300` `RATE_POLLS_PER_MINUTE=300` `QUOTA_LOOKUPS_PER_DAY_FREE=1000` `RATE_LOGIN_PER_IP_PER_MIN=10` `RATE_LOGIN_PER_EMAIL_15MIN=5` `RATE_SIGNUP_PER_IP_PER_HOUR=10` `MAX_WAIT_SEC=25` `REQUEST_TIMEOUT_MS=45000` `HEADERS_TIMEOUT_MS=10000` `KEEPALIVE_TIMEOUT_MS=5000` `MAX_CONNECTIONS=3000` `BODY_LIMIT_BYTES=4096` `MAX_LONGPOLL_WAITERS=1500` `PRINCIPAL_CACHE_TTL_MS=60000` `PRINCIPAL_CACHE_ENTRIES=2000` `SESSION_SECRET` `SESSION_TTL_DAYS=7` `SCRYPT_N=32768` `SCRYPT_CONCURRENCY=2` `SMTP_HOST=smtp.gmail.com` `SMTP_PORT=465` `SMTP_USER` `SMTP_APP_PASSWORD` `MAIL_FROM="GSTIN by Sandbee <SMTP_USER>"` `ADMIN_EMAIL` `ALERT_COOLDOWN_MS=3600000` `ADMIN_TOKEN` `REQUIRE_EMAIL_VERIFY=true` `SHUTDOWN_GRACE_MS=10000` `GST_PYTHON` `PORTAL_STUB` `LOG_LEVEL=info`.

---

## 11. Testing

Runner: `node --test`. Injected `{ client, solver, db, clock, mailTransport }` everywhere. Mongo-backed tests use `mongodb-memory-server` through the same `ensureIndexes()`. Pure-logic tests use `fakeClock` and no Mongo. Existing 30 Node, 10 Python, 4 browser tests keep passing (import paths updated; browser tests rewritten for the new UI).

Fixtures: `test/fixtures/fake-portal.js` (transport stub; latency distribution median 1.0 s / p90 2.3 s / max 3.6 s in virtual time; abstain-tagged images; fault injection `resetRate`, `status429AtCall`, `status403AtCalls`, `blockPageAtCall`, `schemaDriftAtCall`; records every call with timestamps and in-flight count), `fake-solver.js` (abstain by tag; `crash`/`hang` modes; in-flight count), `clock.js`, `fake-mail.js`.

Unit suites (one per module, named after it): router/server, password/session/apikeys, principal resolver + cache, rate-limiter, batching (ReadBatcher windows, WriteCoalescer flush/overflow order), ulid, gstin-cache (fresh/stale/negative/L1), quota (IST boundary), ledger (insert-before-202 order, recovery order, unique partial index), queue (fairness, caps, lane lift, ETA, orphans, deadline), notifier (hold budget from arrivedAt), challenges (TTL, consume-once), portal-gate (ramp, drop, gap, bucket, budget, every circuit rule, persistence, probe), solver-supervisor (slot wait, restart+retry, degraded, abstain monitor, boot assertion), runner (each outcome row of §3.4, api options → exactly 3 GETs on final INVALID_CAPTCHA, abstain policy), dispatcher (fan-out to followers, never aborts mid-call), admission (every step of §3.1 with the exact code), mailer (201 before SMTP, retry schedule, dead, alert cooldown), auth routes, lifecycle (SIGTERM drain, boot recovery).

**Burst acceptance (`test/burst.test.js`, virtual time; `scripts/load-burst.js`, real HTTP loopback):**
- A: 1000 requests, 200 keys × 5, 40 % cache warm, 20 % duplicate misses, wait=25 → codes sum to 1000; ≈400 × 200 HIT/STALE; ≈26 × 200 portal/coalesced; ≈574 × 202; 0 × 4xx/5xx; every 202 job reaches a terminal state and is readable by its owner; FakePortal in-flight ≤ 1 before 50 clean lookups and ≤ 2 after, never 3; min gap between call starts ≥ 245 ms; total portal calls ≤ 2.3 × leaders + probes; heap growth < 50 MB; event-loop lag p99 < 100 ms; Mongo round trips during admission ≤ 15.
- B: 1000 from one key → 60 admitted, 940 × 429 RATE_LIMITED, ≤ 10 leaders, rest 429 MISS_RATE_LIMITED, 0 Mongo ops for the 940.
- C: 1000 same GSTIN cold → 1 leader, exactly 2 portal calls, 1000 × 200 for wait ≥ 2.
- D: 1000 distinct cold from 300 keys → 1000 leaders; 1001st → 503 QUEUE_FULL with estimatedWaitSec > 0.
- E: A + 429 at portal call 90 → 0 portal calls during cooldown, exactly 1 probe, probe is never a customer job, `portal_state.pausedUntil` written.
- F: A + two 403s → circuit open 600 s, no third call reaches transport, one alert row in `email_outbox`.
- G: A + FakeSolver crash at image 20 then recovery → affected job completes, 0 CAPTCHA_UNSOLVED.
- H: A + stop at t=60 s, new app on the same memory-server → all queued jobs recovered in `_id` order, running → queued, no duplicate active leader.
- I: warm repeat of A → 0 Mongo reads, 1000 × 200 within 300 ms wall.

Browser (Playwright, existing config): signup → verify (link read from fake mail) → onboarding → lookup → manual CAPTCHA modal with countdown → result → JSON download; queued lookup shows position and completes via polling; Needs-your-help solve; API key one-time reveal; mobile 390 px no horizontal scroll.

Live pre-flight (manual, not CI): `node scripts/verify-live.js <GSTIN> --ramp` on the deployed host before raising `PORTAL_CONCURRENCY_MAX`.

---

## 12. Repository layout

```
src/
  index.js  app.js  config.js  clock.js  errors.js  ulid.js  rate-limiter.js
  http/server.js  http/router.js
  auth/password.js  auth/session.js  auth/apikeys.js  auth/principal.js  auth/users.js  auth/keys.js  auth/routes.js
  store/batching.js  db.js
  admission.js  queue.js  dispatcher.js  portal-gate.js  runner.js  solver-supervisor.js  challenges.js
  ledger.js  gstin-cache.js  quota.js  notifier.js  mailer.js  janitor.js  lifecycle.js  routes.js  metrics.js
  lib/gst-client.js  lib/lookup.js  lib/ocr-worker.js          (foundation, additive changes)
ocr/captcha_ocr.py  ocr/captcha_preprocess.py  ocr/requirements.txt
public/index.html signup.html login.html verify.html forgot.html reset.html onboarding.html app.html docs.html style.css common.js app.js
test/*.test.js  test/fixtures/{fake-portal,fake-solver,clock,fake-mail,ocr-worker.cjs,gst/}  test/browser/*.spec.js  test/test_ocr.py  test/burst.test.js
scripts/load-burst.js  scripts/verify-live.js  scripts/benchmark-ocr.py
docs/  legacy/
Dockerfile  .dockerignore  docker-compose.yml  docker-compose.prod.yml  Caddyfile  .env.example  package.json  README.md
```

Dependencies: `mongodb ^7.6`, `nodemailer ^10`. Dev: `@playwright/test` (existing), `mongodb-memory-server`. Python: unchanged `ocr/requirements.txt`. No other runtime dependencies.

---

## 13. Open risks (carried from the panel)
- Portal behaviour at concurrency 2 / ~3.8 hits/s is unmeasured; the ramp, budget and breaker bound the damage. Run `verify-live.js --ramp` on the production egress IP before trusting ETAs.
- Portal rate limit and ban policy are unknown; budgets (6000/h, 50k/day) are chosen, not derived.
- Atlas M0 storage accounting and ops throttle are assumed conservatively; compare `db.stats()` with the Atlas UI on day 7.
- Gmail app-password SMTP caps at ~500 mails/day and can be revoked; the outbox makes it visible.
- Single egress IP, single process: no redundancy by design.
- CAPTCHA format change drops automatic coverage to zero; abstain monitor degrades gracefully.
