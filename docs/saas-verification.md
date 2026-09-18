# SaaS build verification — 18 September 2026

Local environment: Windows host, Docker Desktop Linux containers, Node 22, Python 3.12, MongoDB 8.0. Production AWS deployment was not performed; the user will provide its environment configuration later.

## Results

- 33 Node tests passed: portal validation/retries, worker recovery, real MongoDB authentication and indexes, session and key revocation, CSRF, per-account atomic counters, concurrent first fetch, cold LRU, rate limits, Secure cookie flags and bounded live queue.
- 10 Python regression tests passed, including image processing and OCR fixtures.
- 4 Playwright browser tests passed: signup/onboarding, key replacement/revocation, lookup and counters, logout/login, mobile navigation/layout, invalid login, settings and password changes.
- Additional HTTP checks rejected malformed JSON (400) and oversized bodies (413).
- React production build and Docker multi-stage image build passed. npm audit reported zero known dependency vulnerabilities at verification time.
- App and authenticated MongoDB containers both report healthy; the persistent OCR worker reports ready.
- Production Compose configuration and Caddy configuration validation passed. Public DNS, certificate issuance and EC2 networking still require deployment-time verification.

## Live lookup

The supplied GSTIN `09AAFPC6958E1ZN` resolved successfully through the Dockerized OCR/API service. The response reported Active. The first live request took 385 ms; the subsequent saved response took 4 ms. Its authenticated test account recorded exactly two successful requests: one live and one cached.

After rebuilding/restarting the app container, a fresh account received the same MongoDB snapshot in 3 ms without a live lookup. The database contains exactly `users` and `gst_records`. Temporary smoke-test accounts were removed and their keys revoked. The successful GST snapshot was retained.

These are sample observations, not latency or universal CAPTCHA-accuracy guarantees. Historical OCR sample measurements and their limits remain in [captcha-research.md](captcha-research.md).

## Reproduce

```sh
npm test
npm run test:ui
npm run check
python -m unittest discover -s test -p test_ocr.py
docker compose up -d --build
docker compose ps
```

The standard test suite uses disposable MongoDB and stubbed portal responses. A real portal check is performed separately through a signed-in account or its generated Bearer key. Tests never need production MongoDB credentials.
