# Ports — Production deployment

Reference for which ports to open (and which to **keep closed**) when deploying
to `rabbitworld.ddns.net` with `docker-compose.yml` + `docker-compose.prod.yml`.

In production **all public traffic goes through Caddy on 80/443**. Everything else
is internal to the Docker network and must not be reachable from the internet.

```
Internet ──▶ :80/:443  Caddy ──┬─ /uploads/* ─▶ minio:9000
                               └─ everything ─▶ frontend:80 ─▶ backend:4000
                                                 (also /webdav, /ws)
```

---

## 1. Must be OPEN to the internet (router port-forward + host firewall)

These are forwarded on your router to the host and allowed through its firewall.

| Port | Proto | Service | Why |
|------|-------|---------|-----|
| **80** | TCP | Caddy | HTTP→HTTPS redirect **and** Let's Encrypt ACME HTTP-01 challenge. Required for the cert to issue/renew. |
| **443** | TCP | Caddy | HTTPS — the app (frontend, `/api`, `/webdav`, `/ws`, presigned `/uploads`). |
| **443** | UDP | Caddy | HTTP/3 (QUIC). Optional but published in the prod compose; open it or drop the `443:443/udp` line. |

> Caddy needs 80 **and** 443 reachable from the public internet at first request,
> or automatic TLS fails (ACME can't validate the domain).

### Only if you run the mail profile (`--profile mail`, docker-mailserver)

| Port | Proto | Service | Why |
|------|-------|---------|-----|
| **25** | TCP | mailserver | Inbound SMTP (receiving mail / MX). Many home ISPs block 25. |
| **587** | TCP | mailserver | SMTP submission (STARTTLS). |
| **465** | TCP | mailserver | SMTPS (implicit TLS submission). |
| **993** | TCP | mailserver | IMAPS (read mailboxes). |

If you instead use an **external SMTP relay** (SendGrid/Mailgun/etc. via `SMTP_*`
env), you do **not** open any of these — outbound only (see §3).

---

## 2. Must stay CLOSED to the internet (internal-only)

The base `docker-compose.yml` still **publishes these on the host** for local/dev
convenience. In production, **block them at the firewall** so only Caddy is exposed.
Containers reach each other over the Docker network regardless of host publishing.

| Host port | Service | Notes |
|-----------|---------|-------|
| 8080 | frontend (nginx) | Reached internally by Caddy as `frontend:80`. |
| 4000 | backend (Express) | Internal `backend:4000`. |
| 9000 | MinIO S3 API | Caddy proxies `/uploads/*` to it; never expose directly. |
| 9001 | MinIO console | Admin UI — keep private (SSH-tunnel if needed). |
| 5432 | PostgreSQL | Database — must never be public. |

`mailpit` (host **8025** web UI, **1025** SMTP) is **dev only** — the prod override
gates it to a `dev-only` profile, so it does **not** run in production.

> Hardening: either firewall these host ports, or bind them to localhost only.
> To remove host publishing entirely in prod, override each service's `ports:`
> (e.g. drop them) in `docker-compose.prod.yml`. Caddy still works because it
> talks to containers by name, not via published host ports.

---

## 3. Outbound (egress) — the host must be able to reach out

Usually allowed by default, but note if you run a restrictive egress firewall:

| Port | Proto | Purpose |
|------|-------|---------|
| 443 | TCP | ACME (Let's Encrypt) cert issuance/renewal. |
| 53 | TCP/UDP | DNS resolution. |
| 587 / 465 / 2525 | TCP | Only if sending via an external SMTP relay (`SMTP_*`). |
| 25 | TCP | Only if docker-mailserver sends mail directly to other MX hosts. |

---

## TL;DR

- **Web only (default prod):** forward/allow **80 + 443 (TCP)** — and 443/UDP for HTTP/3.
- **Block** 5432, 9000, 9001, 4000, 8080 from the public internet.
- **Mail:** add **25, 587, 465, 993** only if running `--profile mail`; nothing extra
  if you use an external SMTP relay.
- DNS `rabbitworld.ddns.net` must point at your public IP (keep the DDNS updater running).

See `docs/deploy.md` for the full deploy procedure.
