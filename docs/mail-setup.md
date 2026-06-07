# Email setup (password reset / verify)

The app sends mail via SMTP (nodemailer, `backend/src/services/mail.service.js`).
It's controlled entirely by env vars — no code changes needed to switch providers.
If `SMTP_HOST` is empty, sending is disabled and reset links are printed to the
backend log instead.

| Var | Meaning |
|-----|---------|
| `SMTP_HOST` | SMTP server host (`mailpit` in dev, `mailserver` in prod, or a relay) |
| `SMTP_PORT` | `1025` (Mailpit), `587` (submission/STARTTLS), `465` (implicit TLS) |
| `SMTP_SECURE` | `true` only for implicit TLS (port 465); `false` for STARTTLS/plain |
| `SMTP_USER` / `SMTP_PASS` | SMTP AUTH credentials (a real mailbox account) |
| `SMTP_FROM` | From header, e.g. `Uploader <no-reply@example.com>` |
| `PUBLIC_APP_URL` | Browser-reachable base URL used in email links |

> Note: accounts that log in with a **username** (no real email) can't receive
> mail — `mail.service` skips non-email recipients and logs a warning.

## Development — Mailpit (default)

Mailpit is a catch-all SMTP server with a web UI; it captures every outgoing
email so you can inspect it without real delivery. It's already wired in
`docker-compose.yml`.

```bash
docker compose up -d
```

- App sends to `mailpit:1025`.
- Open the inbox at **http://localhost:8025** (or `http://<host>:8025`).
- Trigger from the app: Login → “Forgot password?”, or
  `POST /api/auth/forgot-password { "identifier": "<user-with-email>" }`.

## Production — docker-mailserver

`docker-compose.prod.yml` swaps Mailpit for [docker-mailserver](https://docker-mailserver.github.io/docker-mailserver/latest/)
(a real Postfix/Dovecot MTA) and points the backend at it.

```bash
cp mailserver.env.example mailserver.env      # edit hostname/TLS/etc.
# set MAIL_HOSTNAME, SMTP_USER, SMTP_PASS, SMTP_FROM, PUBLIC_APP_URL in your .env

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# create the sending mailbox (one time)
docker exec -it uploader-mailserver setup email add no-reply@example.com '<strong-password>'
# generate DKIM keys, then publish the printed DNS record
docker exec -it uploader-mailserver setup config dkim
```

Then set in `.env` (read by the prod compose override):

```
MAIL_HOSTNAME=mail.example.com
SMTP_USER=no-reply@example.com
SMTP_PASS=<the password you set above>
SMTP_FROM=Uploader <no-reply@example.com>
PUBLIC_APP_URL=https://uploader.example.com
```

### DNS / deliverability (required for real inboxes)
A real domain with these records, or mail lands in spam / is rejected:
- **A** `mail.example.com` → server IP
- **MX** `example.com` → `mail.example.com`
- **SPF** TXT: `v=spf1 mx ~all`
- **DKIM** TXT: the record printed by `setup config dkim`
- **DMARC** TXT `_dmarc.example.com`: `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com`
- **PTR** (reverse DNS) for the server IP → `mail.example.com` (set at your host/ISP)
- Outbound **port 25** must be open (many home ISPs block it).

The dev `mailpit` service is profile-gated (`dev-only`) in the prod override, so
it won't run under the prod command.
