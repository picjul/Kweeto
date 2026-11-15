# Security

## Threat model

Kweeto is a **single-user application meant to run on your own machine**. It has **no authentication**: anyone who
can reach its ports can read, change and delete every project, upload files and start background jobs.

- The backend (`:8000`, which holds all the data) listens on `127.0.0.1` in the dev scripts and inside the Docker
  image; Docker Compose publishes port 3000 on `127.0.0.1` only. Keep it that way.
- Do not expose it to a network you do not trust (no port forwarding, no public cloud VM without a VPN or an
  authenticating reverse proxy in front).

## Protection against other websites

A page you visit in the same browser could otherwise talk to Kweeto on `127.0.0.1`. Kweeto refuses:

- **Cross-site requests (CSRF)**: every request that changes data and comes from a browser must carry the
  `X-Kweeto: 1` header, which Kweeto's own pages send. Another site cannot add it without a CORS preflight, and the
  origin allow-list (`KWEETO_CORS`) refuses that. Scripts and tools without browser headers (curl, Python) are not
  affected.
- **DNS rebinding**: the backend and the frontend server answer only to the host names in `KWEETO_ALLOWED_HOSTS`
  (default `localhost,127.0.0.1,[::1]`). If you serve Kweeto under another name, for example behind your own
  authenticating reverse proxy, add that name there.
- **Files outside the project**: image and thumbnail URLs only serve plain file names inside the project folder.
- Imported files (images, annotation files, zips) are parsed locally; paths inside archives are sanitised and every
  file stays inside the project folder.
- Plugins (`backend/plugins/*.py`, `KWEETO_PLUGINS`) are ordinary Python code run with your permissions: only
  install plugins you trust.

The code has not had a professional security audit.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting ("Security" tab → "Report a
vulnerability") on the repository, with steps to reproduce. You will get an answer as soon as possible; fixes are
released as patch versions and mentioned in the [CHANGELOG](CHANGELOG.md).

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ |
| < 1.0 | ❌ |
