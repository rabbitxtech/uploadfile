# Mail DNS records — rabbitworld.ddns.net

The docker-mailserver is **working** (the app sends, postfix delivers, messages are
DKIM-signed). For external providers like Gmail to **accept** that mail (inbox vs
reject/spam) you must publish the records below in the DNS zone for
`rabbitworld.ddns.net`, and ideally have matching reverse DNS.

> ⚠️ **Zone control required.** Free DDNS hostnames (No-IP `*.ddns.net`, etc.)
> usually only let you set the A record — **not** TXT/MX/DKIM. If you can't add
> these records, Gmail/Outlook will reject or spam your mail no matter what, and
> an external SMTP relay (SendGrid/Brevo/etc.) is the realistic option.

Sending IP: **171.237.136.108** (residential — see the rDNS note below).

## Records to publish

| Type | Host / Name | Value |
|------|-------------|-------|
| A | `mail` | `171.237.136.108` |
| MX | `@` (root) | `10 mail.rabbitworld.ddns.net.` |
| TXT (SPF) | `@` (root) | `v=spf1 a:mail.rabbitworld.ddns.net ip4:171.237.136.108 -all` |
| TXT (DKIM) | `mail._domainkey` | see DKIM value below (one TXT record) |
| TXT (DMARC) | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@rabbitworld.ddns.net` |

### DKIM TXT value (`mail._domainkey`)
```
v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApuF6aPePLUS7ONec8jhxphlRMMp3OIWlrezoDm2RX3hYMhVxsA3rP0ALY80SxXg5+v+xen/vyJrYx4S+oQc9CSrvWz9WsyIkAC4PLIVIQ+xlC4jRvMS21yr/7LwfU3EwA10ovTxXnP/OXu8QoGQCOdpzIp9uW3gY5QG/qnaG38biu8mkmciuAwtOSB+URpvfkJt8JofKX4gI2UfTdix6YlZGtJXgSBU6h1JUA9tVHfk83YmPuIZRttGU/wr/tfxPjV+k+TuZBVDzKd1nQIcEWaIWxazEUWQyvt/H+6XnrAt3HfKqsAnRUzntp7GOHG820ymnDwXLCup0ZfjNW64K1wIDAQAB
```
If your DNS UI rejects the long value, split it into 255-char quoted chunks
(`"part1" "part2"`) — most providers do this automatically.

## Reverse DNS (PTR) — the hard part on a home connection
Gmail wants forward-confirmed reverse DNS: a PTR for `171.237.136.108` that
resolves to `mail.rabbitworld.ddns.net`. PTR is controlled by your **ISP**, not by
DNS you manage. Residential ISPs rarely set a custom PTR, so mail from a home IP
is frequently rejected or spam-filed even with perfect SPF/DKIM/DMARC. If
deliverability matters, route outbound through a relay (set `SMTP_*` in `.env`).

## Verify after publishing
```bash
dig +short TXT mail._domainkey.rabbitworld.ddns.net
dig +short TXT rabbitworld.ddns.net          # SPF
dig +short TXT _dmarc.rabbitworld.ddns.net
# Then send a real test and check headers (SPF=pass, DKIM=pass, DMARC=pass):
#   register a user with your real address, or use https://www.mail-tester.com
```

## How the server is wired (recap)
- Backend → `mailserver:25` (plaintext, no auth) via `PERMIT_DOCKER=connected-networks`.
- postscreen is bypassed (`docker-data/dms/config/user-patches.sh`) — it segfaults
  on Docker Desktop; we only send, so it isn't needed.
- Mail data/state/queue are on **named volumes** (host bind mounts break the
  postfix queue on Docker Desktop with "queue file write error").
- DKIM selector `mail`, generated with
  `setup config dkim keysize 2048 selector mail domain rabbitworld.ddns.net`.
