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
   this machine. (Mail also needs 25/587 if you run `--profile mail`.)
3. Docker + Docker Compose installed.

## First deploy
```bash
cp .env.prod.example .env          # then edit .env
#   JWT_SECRET=$(openssl rand -base64 48)   # REQUIRED
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
Caddy obtains the TLS cert automatically on first request (needs ports 80/443
reachable from the internet). Visit **https://rabbitworld.ddns.net**.

The first registered user becomes admin (registration is currently disabled in
code — create users via the admin UI, or re-enable register temporarily).

## With real email (docker-mailserver)
```bash
cp mailserver.env.example mailserver.env     # edit hostname/TLS
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile mail up -d
docker exec -it uploader-mailserver setup email add no-reply@rabbitworld.ddns.net '<pwd>'
docker exec -it uploader-mailserver setup config dkim
# set SMTP_USER/SMTP_PASS in .env to that mailbox; publish the SPF/DKIM/DMARC DNS
```
See `docs/mail-setup.md` for the full DNS checklist. Without the `mail` profile
(or external SMTP), reset emails are skipped and the link is printed to the log.

## Notes / hardening
- The frontend stays same-origin (`VITE_API_BASE=""`), so the prebuilt image
  works for any domain — no rebuild needed when the domain changes.
- Presigned media (images/audio/download) are signed against
  `https://rabbitworld.ddns.net` and proxied to MinIO by Caddy; **video** streams
  through the authenticated backend `/stream` endpoint (no presigned URL).
- For defense in depth, also change the default Postgres/MinIO passwords in
  `docker-compose.yml` (keep `DATABASE_URL` and the MinIO keys in sync), and
  consider firewalling the still-published `:8080` (frontend) and `:9000` (MinIO)
  host ports so all public traffic goes through Caddy/443.
- Updating the app: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
  then `docker compose restart frontend` if the backend was recreated (nginx
  caches the backend IP).
```
