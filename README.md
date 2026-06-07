# Uploader — File Upload & Management

Full-stack file storage app: **React** (frontend) + **Node.js/Express** (backend) + **MinIO** (object storage) + **PostgreSQL/MySQL/SQLite** (metadata via Prisma). Ships with a one-command **production deploy** (Caddy + automatic HTTPS), optional **OCR + semantic search**, **WebDAV**, **real-time presence**, and **email** (Mailpit in dev, docker-mailserver in prod).

## Features

### Auth & users
- **Self-registration with email verification** — sign-up requires a real email and a confirmed password; a verification link is mailed, and login is blocked until it's clicked (resend supported). The first account auto-becomes a verified `admin`; admin-created accounts skip verification.
- **Admin approval to upload** — self-registered users can log in and browse but **can't upload until an admin approves them** (admins are notified when a new user verifies; approve/revoke from the Users page). First-user/admin-created accounts are pre-approved.
- Username **or** email login (regular usernames must be `letters/digits/. _ -`)
- JWT auth with `admin` / `user` roles, per-user quota
- **Session management** — every login is a revocable session; a "Active sessions" panel lists your devices (browser/OS, IP, last active) and lets you sign out one or all others. Changing your password signs out every other device; a reset signs out all.
- **API keys** (`uk_` prefix, hashed) for programmatic / WebDAV access
- **Password reset** by email (forgot-password → tokened reset link); confirm-password on register & password change
- Admin can create users, change roles, change quotas, reset passwords, ban/unban, delete
- Admin can browse another user's files read-only via `/files?as=<userId>`
- Welcome / role-change / quota-change / ban / share-download notifications (in-app inbox, 30s polling)

### Files & folders
- Folder tree in its own collapsible column (round edge toggle on desktop, modal on mobile) with expand/collapse and **drag-and-drop file move**
- **Chunked / resumable upload** for large files (MinIO multipart, 8 MiB parts)
- **Upload from URL** — server-side fetch into storage (SSRF-guarded)
- **Replace-on-duplicate** flow: name conflict surfaces a dialog with "apply to all remaining" checkbox; old file + MinIO object atomically replaced, quota refunded
- File versioning, tags (chip + popover editor), full-text search, tag filter
- Preview (images w/ lightbox + EXIF, video, audio, text/markdown w/ syntax highlight) and auto-generated thumbnails (`sharp`)
- **Comments** on files (visible to anyone with read access)
- **Collections** — group files across folders (a file can be in many)
- Trash bin (soft delete + restore + empty + hard delete) with **auto-clean** — items left in trash past a retention window are purged automatically (quota refunded)
- Bulk operations: trash, move, **bulk rename**, **download as ZIP**
- List view + image **grid view** (with auto-suggestion when ≥ 50% of files are images)
- Recent (recently accessed) and Starred views; **storage analytics** + **duplicate finder**

### Search & AI (optional, best-effort)
- **OCR** of images and PDFs (`tesseract` + `pdftoppm`) — extracted text is searchable
- **Semantic search** via on-device embeddings (`@xenova/transformers`, MiniLM) — no external API

### Sharing
- **Public share links** for files or folders with expiry, password (bcrypt), download cap, optional **upload drop-box** (`allowUpload`)
- **Share to a specific user** (grants) — recipient sees it under "Shared with me"
- Public folder share renders a list + "Download folder as ZIP"
- Owner notified when shared content is downloaded; per-share access log

### Real-time & access
- **Presence**: live viewer avatars on a file preview (WebSocket `/ws`)
- **WebDAV** mount (`/webdav`, HTTP Basic / API key) — browse storage as a network drive
- **Protected video streaming**: authenticated `/stream` endpoint with HTTP Range + a short-lived **HttpOnly cookie** credential (never in the URL, so it can't be shared or replayed; MinIO URL never exposed, `nodownload`)

### UX
- Light + Dark mode (Tailwind class-based, persisted, FOUC-safe via inline init script)
- **PWA** — installable, offline shell (over HTTPS), with **camera upload** (Take photo), **Web Share Target** (share files from other apps straight into Uploader), and an **offline upload queue** that auto-sends when you reconnect
- **Command palette** (Ctrl/⌘-K)
- Mobile responsive (sidebar drawer + hamburger top bar < `md`)
- Imperative `confirmDialog` / `promptDialog` (no native browser modals)
- In-app notification bell with portal-positioned dropdown
- Toast notifications via `react-hot-toast`

### Security
- Rate limiting on auth + public routes (`express-rate-limit`, proxy-aware)
- **Audit log** (admin-viewable) of sensitive actions
- SSRF guard on upload-from-URL (DNS-resolution check, **re-validated on every redirect hop**)
- **Content-Security-Policy** enabled (helmet); password-protected shares don't reveal their contents until unlocked
- Refuses to start in prod without a strong `JWT_SECRET`; redacted structured logs

### Storage / infra
- Swappable database: switch `DB_PROVIDER` between `postgresql` / `mysql` / `sqlite`
- Two MinIO clients (internal Docker hostname + public-facing) so presigned URLs are browser-reachable
- **Email** — Mailpit catcher in dev, docker-mailserver (or any SMTP relay) in prod
- **One-command production deploy** with Caddy + automatic HTTPS (see below)

## Quick start — Docker Compose

```bash
docker compose up --build
```

Then open:

- Frontend: <http://localhost:8080>
- Backend API: <http://localhost:4000>
- MinIO console: <http://localhost:9001> (login: `minioadmin` / `minioadmin`)

The first account you register becomes `admin`. Schema is applied automatically on container start via `prisma db push`.

The dev stack also runs **Mailpit** — outgoing mail (e.g. password resets) is caught and viewable at <http://localhost:8025> (nothing leaves the machine).

## Production deploy (Caddy + automatic HTTPS)

`docker-compose.prod.yml` adds a Caddy reverse proxy that terminates TLS and obtains/renews Let's Encrypt certificates automatically. It currently targets the domain **`rabbitworld.ddns.net`** (edit `Caddyfile` + the prod env to change it).

```bash
cp .env.prod.example .env          # set JWT_SECRET (required) etc.
JWT_SECRET=$(openssl rand -base64 48) \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Architecture:

```
browser ──HTTPS──▶ Caddy (:443)
                     ├─ /uploads/* ─▶ minio:9000        (presigned media, same-origin)
                     └─ everything ─▶ frontend:80 ─▶ backend (/api, /webdav, /ws)
```

**Prerequisites:** `rabbitworld.ddns.net` resolves to your public IP (keep the DDNS updater running) and the router forwards ports **80 + 443**. For real outgoing email add `--profile mail` (runs docker-mailserver; needs ports 25/587 + SPF/DKIM/DMARC DNS). Full instructions, hardening notes, and the mail DNS checklist live in **[`docs/deploy.md`](docs/deploy.md)** and **[`docs/mail-setup.md`](docs/mail-setup.md)**.

## Quick start — local (no Docker)

You need PostgreSQL (or MySQL) and a MinIO server running.

```bash
cp .env.example .env             # edit values to taste

# Backend
cd backend
npm install
npm run db:switch postgresql     # or: mysql | sqlite
npx prisma migrate dev --name init
npm run dev                      # http://localhost:4000

# Frontend (new terminal)
cd frontend
npm install
npm run dev                      # http://localhost:5173
```

### Switching the database

```bash
cd backend
npm run db:switch mysql          # rewrites prisma/schema.prisma provider line
# update DATABASE_URL in .env to a mysql URL
npx prisma migrate dev --name init
```

### Required env vars

```
DATABASE_URL                      Prisma connection string (matches DB_PROVIDER)
MINIO_ENDPOINT / MINIO_PORT       Internal MinIO host (e.g. `minio` in Docker, `localhost` standalone)
MINIO_PUBLIC_ENDPOINT             Browser-reachable URL for presigned URLs (e.g. http://localhost:9000)
MINIO_ACCESS_KEY / MINIO_SECRET_KEY
MINIO_BUCKET                      defaults to `uploads`
JWT_SECRET                        rotate this in production (prod refuses weak/default values)
JWT_EXPIRES_IN                    e.g. `7d`
CORS_ORIGIN                       comma-separated allowlist (or `*`)
DEFAULT_QUOTA_BYTES               default per-user quota for new accounts
TRASH_RETENTION_DAYS              auto-purge trashed items older than N days (default 30; 0 disables)
PUBLIC_APP_URL                    frontend base URL (used in password-reset email links)

# Email (optional — all best-effort; skipped if unset)
# Powers password-reset + email-verification links. Prod uses a Gmail relay
# (smtp.gmail.com:587, SMTP_SECURE=false, a 16-char Gmail App Password).
SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM
SMTP_ALLOW_SELFSIGNED             set true only for a relay with a self-signed cert

# AI (optional — features degrade gracefully if the CLIs/models are absent)
TRANSFORMERS_CACHE                where the embedding model is cached (Docker: /app/models)
```

> **Note:** the backend Docker image is **Debian-based** (`node:20-bookworm-slim`) and installs `tesseract-ocr`, `poppler-utils`, and `ffmpeg` so OCR, semantic search, and video posters work out of the box. Running on an alpine/musl base disables these.

## Repo layout

```
backend/                Express + Prisma + MinIO SDK
  prisma/schema.prisma  Multi-provider data model (User, Folder, File, FileVersion,
                        Tag, Share, ShareAccess, FileGrant, FolderGrant, Comment,
                        Collection, UploadSession, Notification, AuditLog, ApiKey,
                        Token, WatchProgress)
  scripts/switch-db.js  Rewrites the `provider` line in schema.prisma
  src/
    config/             env, prisma client, minio (internal + public clients), logger
    middleware/         auth (requireAuth + API keys), error handler, rate limiting
    realtime/           presence.js — WebSocket viewer presence at /ws
    routes/             auth, files, folders, upload, shares, grants, collections,
                        trash, users, notifications, keys, audit, webdav
    services/           storage (minio), thumbnail, video, quota, notify, mail,
                        ai (OCR + embeddings), checksum, audit, access (grants)
    utils/              http error helpers, asyncHandler
  Dockerfile            Debian base; installs tesseract/poppler/ffmpeg; migrate + serve

frontend/               React + Vite + Tailwind + React Query + Zustand (PWA)
  index.html            inline theme-init script (avoids dark-mode flash)
  nginx.conf            serves the SPA; proxies /api, /webdav, /ws to the backend
  src/
    api/                axios client + endpoints, chunked upload (fetch streaming)
    components/         Layout, Uploader, FileRow, FolderTree, Dialog (imperative),
                        PreviewModal, VideoPlayer, AudioPlayer, ImageLightbox,
                        TextPreview, ShareModal, AddToCollectionModal,
                        BulkRenameModal, CommandPalette, NotificationBell
    pages/              Login, Register, Forgot/ResetPassword, Files, Recent,
                        Starred, Trash, Shares, SharedWithMe, Shared (public),
                        Collections, CollectionView, Duplicates, Stats, Audit,
                        Profile, Users (admin)
    store/              auth (zustand persisted), theme (zustand persisted)
    lib/                format helpers, presence (WS client), uid (secure-ctx fallbacks)

docker-compose.yml      Postgres + MinIO + backend + frontend + Mailpit (dev)
docker-compose.prod.yml Caddy (HTTPS) + prod env + optional docker-mailserver
Caddyfile               reverse proxy / automatic TLS for the production domain
docs/                   deploy.md, mail-setup.md
```

## Routing map

```
/api/auth              register, login, me, verify-email, resend-verification,
                       forgot-password, reset-password,
                       sessions (list / revoke / revoke-others), logout
/api/folders           list (?parentId=, admin ?ownerId=), tree, breadcrumb,
                       create, rename/move, soft-delete
/api/files             single-shot upload, from-url, get, rename/move/tag,
                       soft-delete, download, presigned URL (?inline=1 for preview),
                       preview stream, thumbnail, versions, recent, starred,
                       :id/star (toggle), :id/optimize, :id/comments,
                       :id/stream (+ :id/stream-token), :id/progress,
                       bulk trash/rename/move/zip,
                       search (q + tag + OCR), semantic-search, reindex (admin),
                       duplicates, analytics
/api/upload            chunked init (with optional replaceFileId) / part /
                       complete / resume / abort
/api/shares            create (file or folder), list, revoke
                       + public/:token, public/:token/unlock (password),
                         public/:token/download, public/:token/upload (drop-box)
/api/grants            shared-with-me, grant file/folder to a user, revoke
/api/collections       list/create/get/update/delete, add/remove files
/api/keys              list / create / revoke API keys (uk_ prefix)
/api/audit             admin: list audit log
/api/trash             list trashed, restore, empty, hard-delete a file
/api/users             /me PATCH (name + password)
                       admin: list, create (with role/quota), update
                       (role/quota/ban/name/password), delete
/api/notifications     list (?unread=1, ?limit=N), :id/read, mark-all-read,
                       :id DELETE, clear (delete all)
/webdav                WebDAV (HTTP Basic / API key)
/ws                    WebSocket presence (?token=&fileId=)
```

Interactive API docs (Swagger UI) are served at `/api/docs`.

## See also

- `.claude/CLAUDE.md` — architecture notes for AI-assisted development (covers MinIO SDK version quirks, the two-client pattern for presigned URLs, dark-mode CSS pitfalls, admin read-as-user semantics, video-stream protection, WebDAV/CORS ordering, and the production Caddy setup).
- `docs/deploy.md` — production deployment (Caddy + HTTPS, hardening).
- `docs/mail-setup.md` — email in dev (Mailpit) and prod (docker-mailserver / SMTP relay).
