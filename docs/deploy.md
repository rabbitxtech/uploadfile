# Production deployment — https://rabbitworld.ddns.net

The production stack adds **Caddy** (automatic HTTPS via Let's Encrypt) in front
of the existing services. The browser talks only to Caddy on 443; Caddy proxies
to the frontend nginx (which routes `/api`, `/webdav`, `/ws` to the backend) and
to MinIO for media (`/uploads/*`).

```
browser ──HTTPS──▶ Caddy (rabbitworld.ddns.net)
                     ├─ /uploads/* ─▶ minio:9000        (presigned media)
                     └─ everything ─▶ frontend:80 ─▶ backend:4000 (/api,/webdav,/ws)
```

## Prerequisites
1. **DNS**: `rabbitworld.ddns.net` resolves to your public IP (keep the DDNS
   updater running).
2. **Router/firewall**: forward **80** and **443** (TCP, +443/UDP for HTTP/3) to
   this machine. Mail also needs 25/587 if you run `--profile mail`. Full port
   list (incl. which to keep closed) is in [`port.md`](../port.md).
3. Docker + Docker Compose installed.

## First deploy
```bash
cp .env.prod.example .env          # then edit .env (prod-env.example.txt = same
                                   # vars, fuller commentary)
#   JWT_SECRET=$(openssl rand -base64 48)   # REQUIRED — prod refuses to start without it
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
- `docker-compose.prod.yml` uses `${JWT_SECRET:?}`, so the value must be present
  (in `.env` or the shell) even for `build`/`config` subcommands.
- The backend container runs `prisma migrate deploy` on startup, so schema
  migrations apply automatically. **Adding a Prisma model needs an image rebuild**
  (so `prisma generate` re-runs and the new migration is copied in).
- Caddy obtains the TLS cert automatically on first request (needs 80/443
  reachable from the internet). Visit **https://rabbitworld.ddns.net**.

### Accounts
- The **first registered user becomes `admin`** (auto-verified and auto-approved).
- Every **later self-registration requires email verification** (a link is mailed;
  login is blocked until clicked) **and then admin approval before they can upload
  files**. Admins get an in-app notification when a new user verifies; approve them
  on the **Users** page. Admin-created accounts skip both steps.
- So email must actually send for self-service signup to work — see below.

## Email (verification + password reset)
Mail is best-effort: if SMTP isn't configured the links are only printed to the
backend log. Two options:

**A. External SMTP relay (recommended).** Simplest and most deliverable. Set in
`.env`:
```
SMTP_HOST=smtp.gmail.com        # or SendGrid/Mailgun/etc.
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@gmail.com
SMTP_PASS=<16-char Gmail App Password>   # requires 2-Step Verification
SMTP_FROM=Admin <you@gmail.com>
PUBLIC_APP_URL=https://rabbitworld.ddns.net   # used to build the email links
```

**B. Self-hosted docker-mailserver (`--profile mail`).**
```bash
cp mailserver.env.example mailserver.env     # edit hostname/TLS
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile mail up -d
docker exec -it uploader-mailserver setup email add no-reply@rabbitworld.ddns.net '<pwd>'
docker exec -it uploader-mailserver setup config dkim
# set SMTP_USER/SMTP_PASS in .env to that mailbox; publish SPF/DKIM/DMARC + a PTR record
```
⚠️ On a **residential IP / DDNS host this usually can't deliver to Gmail** (no
control over PTR/reverse-DNS; SPF/DKIM alone aren't enough) — prefer option A.
Full DNS checklist in [`mail-setup.md`](./mail-setup.md).

## Configuration / feature flags (`.env`)
| Var | Purpose |
| --- | --- |
| `JWT_SECRET` | **Required.** Long random secret; rotating it logs everyone out. |
| `PUBLIC_APP_URL` | Base URL used in verification/reset email links. |
| `DEFAULT_QUOTA_BYTES` | Per-user storage quota for new accounts. |
| `TRASH_RETENTION_DAYS` | Auto-purge trashed items older than N days (`0` disables). |
| `ZIP_DOWNLOAD_ENABLED` | `false` locks ZIP download (bulk + folder-share). Surfaced to the SPA via `GET /api/config`. |
| `VIDEO_IMPORT_HOSTS` | Extra allowed domains for video import (comma-separated) on top of the built-in allowlist. |
| `MAX_SHARES_PER_USER` / `MAX_API_KEYS_PER_USER` | Cap active share links / API keys per user (admins exempt; `0` = unlimited). |
| `DROPBOX_MAX_UPLOADS_PER_SHARE` / `DROPBOX_MAX_FILE_BYTES` | Anti-abuse caps on anonymous drop-box links (per-link upload count; per-file byte cap, `0` = global 100 MB). Anonymous uploads are also IP rate-limited (20/15 min). |
| `DOWNLOAD_BANDWIDTH_KBPS` | Throttle authenticated downloads to N KB/s per connection (`0` = unlimited). |
| `SMTP_*`, `SMTP_ALLOW_SELFSIGNED` | Outgoing mail (see above). |

Changing an env value needs a backend recreate:
`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend`.

## Notes / hardening
- The frontend stays same-origin (`VITE_API_BASE=""`), so the prebuilt image
  works for any domain — no rebuild needed when the domain changes.
- Presigned media (images/audio/download) are signed against
  `https://rabbitworld.ddns.net` and proxied to MinIO by Caddy; **video** streams
  through the authenticated backend `/stream` endpoint (HttpOnly cookie, no
  presigned URL).
- **Video import** (`yt-dlp` + `ffmpeg`, both baked into the backend image) is
  restricted to a curated allowlist of reputable sources and runs only for
  approved users. Its endpoint has a dedicated long, unbuffered nginx location so
  it can stream live progress.
- For defense in depth, change the default Postgres/MinIO passwords in
  `docker-compose.yml` (keep `DATABASE_URL` and the MinIO keys in sync), and
  firewall the still-published host ports `:8080` (frontend) and `:9000/:9001`
  (MinIO) so all public traffic goes through Caddy/443.
- **Updating the app:**
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
  If only the backend was recreated, also `docker compose ... restart frontend`
  (nginx caches the backend container IP).
