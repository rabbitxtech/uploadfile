# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Full stack via Docker (recommended for first run)
docker compose up --build

# Backend (standalone)
cd backend
npm install
npm run db:switch postgresql        # or: mysql | sqlite
npx prisma migrate dev --name init  # creates tables
npm run dev                         # node --watch src/server.js

# Frontend (standalone)
cd frontend
npm install
npm run dev                         # Vite on :5173 (proxies /api -> :4000)
npm run build

# Prisma utilities
cd backend
npm run db:studio                   # GUI at :5555
npm run db:migrate -- --name <msg>  # new migration after schema edits
npm run db:push                     # quick schema sync without migration files

# Production (Caddy + automatic HTTPS at rabbitworld.ddns.net)
JWT_SECRET=$(openssl rand -base64 48) \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# add `--profile mail` to also run docker-mailserver. See docs/deploy.md.
```

The backend image is **Debian (`node:20-bookworm-slim`), not alpine** — `@xenova/transformers` (onnxruntime) ships glibc binaries that segfault on musl. The Dockerfile also `apt install`s the CLIs the AI/video features shell out to: `tesseract-ocr`(+`-eng`/`-vie`), `poppler-utils` (pdftoppm), `ffmpeg`. If you move back to alpine, OCR/embeddings/video-poster generation all break.

Tests run with Vitest: `cd backend && npm test` (unit + Supertest on `/health` and OpenAPI) and `cd frontend && npm test` (Vitest + React Testing Library). CI (`.github/workflows/ci.yml`) runs both plus a frontend lint + build.

Migrations: the schema is versioned under `backend/prisma/migrations` (baseline `0_init`). The Docker backend container runs `prisma migrate deploy` at startup. The original db-push database was baselined with `prisma migrate resolve --applied 0_init`; fresh databases get `0_init` applied automatically. After editing `schema.prisma`, create a new migration with `npm run db:migrate -- --name <msg>` (don't go back to `db push`, or you'll desync the migration history). **Adding a model still requires a backend image rebuild** so `prisma generate` re-runs and the new migration is copied in.

Logging: structured JSON via Pino + `pino-http` (`backend/src/config/logger.js`); `authorization`/`cookie` headers are redacted. API docs are served by `swagger-ui-express` at `/api/docs` (+ raw `/api/openapi.json`), sourced from the hand-maintained `backend/src/openapi.js`.

## Architecture

Three layers; understand all three to make non-trivial changes.

**Object storage (MinIO).** Files are never stored on disk by Node — they go straight into MinIO and are referenced by `objectKey`. The wrapper `backend/src/services/storage.service.js` is the *only* code that touches the SDK; routes call it. Multipart helpers (`initiateMultipart`, `uploadPart`, `completeMultipart`) drive the chunked-upload flow and rely on lower-level methods of the MinIO client — version bumps of `minio` can break the part-upload signature (see "MinIO SDK internals" below).

Two MinIO clients live in `backend/src/config/minio.js`:
- `minio` — uses Docker-internal hostname (e.g. `minio:9000`). All server-side I/O.
- `minioPublic` — uses `MINIO_PUBLIC_ENDPOINT` (e.g. `http://localhost:9000`) so presigned URLs are browser-reachable. `region: 'us-east-1'` is set on this client to skip the `GetBucketLocation` lookup that would otherwise try to reach the public host from inside the container and fail with ECONNREFUSED. `presignedGet` uses this client.

**Metadata DB (Prisma, swappable).** The schema covers `User → Folder → File → FileVersion`, plus `Tag`, `Share`/`ShareAccess`, `FileGrant`/`FolderGrant`, `Comment`, `Collection` (+ `_CollectionFiles` m2m), `UploadSession`, `Notification`, `AuditLog`, `ApiKey`, `Token` (password reset **and** email verification, discriminated by `type`), and `WatchProgress`. `User` carries an `emailVerified Boolean`. `File` also carries `ocrText`/`embedding`/`checksum` (AI + dedup) and `starred`/`accessedAt`. Prisma is configured with a single static `provider`, but `backend/scripts/switch-db.js` rewrites that line to `postgresql`/`mysql`/`sqlite`. After switching, re-run `prisma migrate dev` (or rebuild the Docker container, which calls `prisma db push`). Quirks the code already works around:
- `BigInt` is used for `size`/`quotaBytes`/`usedBytes`; `backend/src/config/prisma.js` adds `BigInt.prototype.toJSON` so Express can serialize them.
- `name: { mode: 'insensitive' }` is PostgreSQL-only in Prisma. Search builds its filter through a `ciContains(q)` helper that adds `mode: 'insensitive'` only when the provider is `postgresql` (gated on `DB_PROVIDER`), and falls back to plain `contains` (relying on collation) on MySQL/SQLite. Don't hardcode `mode: 'insensitive'` in a query — it throws on the non-PG providers.
- `UploadSession.parts` is stored as a JSON string (not `Json` column) for SQLite/MySQL compatibility.

**Two upload paths.** Small files go through `POST /api/files` (multer, memory storage, 100 MB limit). Large files use the chunked flow:
1. `POST /api/upload/init` → reserves a MinIO multipart upload, persists an `UploadSession`. Accepts optional `replaceFileId` — see "Replace-on-duplicate" below.
2. `PUT /api/upload/:id/part?part=N` with raw body → uploads one ~8 MiB chunk, records the part ETag in `UploadSession.parts`.
3. `POST /api/upload/:id/complete` → calls `completeMultipart`, creates the `File` row, increments user `usedBytes`, kicks off thumbnail generation. If `replaceFileId` was set, deletes the old `File` row + MinIO object (best-effort async) and refunds its bytes to the quota *before* creating the new row.
4. `GET /api/upload/:id` → resume info (list of uploaded part numbers); the client skips uploaded parts on retry.

The frontend chunked upload client lives at `frontend/src/api/upload.js`; it uses `fetch` (not axios) for the raw `PUT` so it can stream a `Blob` directly. The `Uploader` component detects duplicates client-side using a passed-in `existingFiles` prop and surfaces a confirm dialog with an optional "apply to all remaining duplicates" checkbox.

**Auth.** JWT bearer in `Authorization` header. The first user to register becomes `admin`. `requireAuth` middleware attaches `req.user` (the full Prisma user) and rejects banned users with 403. Public share routes (`/api/shares/public/...`) deliberately mount *before* `router.use(requireAuth)` in `shares.routes.js` — keep that order if you add routes there.

The login identifier accepts either a regular username (`/^[a-zA-Z0-9._-]+$/`) or an email — both stored in the `User.email` column for backward compat. Validation lives in `auth.routes.js` (`identifier` schema) and `users.routes.js` (admin create user).

**Email verification (self-registration).** Public `/api/auth/register` *requires a real email* and does **not** return a session token — it creates an unverified user, issues a `verify` `Token` (24h TTL), sends the link via `sendVerifyEmail`, and returns `{requiresVerification, email, message}`. The user must click `${PUBLIC_APP_URL}/verify-email?token=…`, which hits `POST /api/auth/verify-email` (sets `emailVerified=true`, returns a real session). `login` throws 403 ("Please verify your email…") while `!emailVerified`. `POST /api/auth/resend-verification` always returns 200 (no account enumeration). **Two exceptions stay auto-verified and skip the flow:** the *first* registered user (becomes `admin`, gets a token immediately) and any admin-created account (`users.routes.js` sets `emailVerified: true`). A backfill migration (`20260606200000_verify_existing_users`) marks all pre-existing accounts verified so they aren't locked out.

**Admin approval gate (upload).** Verifying email is *not* enough to upload: a self-registered user has `User.approved=false` and the `requireApproved` middleware (`middleware/auth.js`, admins always pass) returns 403 on every upload entry point — `POST /api/files`, `POST /api/files/from-url`, `POST /api/files/:id/versions`, and `POST /api/upload/init`. They can still log in and browse; the upload UI in `Files.jsx` is hidden behind a "pending approval" banner (gated on `canUpload = role==='admin' || approved`). First user (admin) and admin-created accounts are auto-`approved:true`; migration `20260607140000_add_user_approval` backfills existing accounts to `true`. On email verification, all admins get an `approval_pending` notification; an admin flips it via `PATCH /api/users/:id {approved:true}` (Approve/Revoke button + "pending" badge in `pages/Users.jsx`), which notifies the user (`approved` notification) and audits `user_approve`/`user_unapprove`. `Files.jsx` re-fetches `/auth/me` on mount for pending users so approval unlocks the UI without a re-login. Frontend: `pages/Register.jsx` (email + confirm-password, "check your email" state), `pages/VerifyEmail.jsx` (StrictMode-guarded auto-verify on mount), `pages/Login.jsx` (resend prompt on the 403). `Profile.jsx` and `Register.jsx` both require a matching confirm-password before submit.

**Login sessions (revocable JWTs).** JWTs are still the bearer credential but now carry a `sid` claim pointing at a `Session` row (`services/session.service.js` → `startSession(user, req)` creates the row and signs the token; login/register/verify-email all go through it). `requireAuth` rejects the token if its session is missing, `revokedAt`, or past `expiresAt` — this is what makes "log out this device" / "log out everywhere" possible despite JWTs being stateless. **Tokens minted before sessions existed have no `sid` and are rejected**, forcing a one-time re-login. Changing your password (`PATCH /users/me`) revokes all *other* sessions (keeps the current one via `req.sessionId`); `reset-password` and an admin password reset revoke *all* of them. Endpoints: `GET /api/auth/sessions` (current flagged), `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others`, `POST /api/auth/logout`. Frontend: the "Active sessions" card in `pages/Profile.jsx`; the sidebar Sign-out button calls `AuthApi.logout()` before clearing local state. `Session.expiresAt` mirrors `JWT_EXPIRES_IN` via `parseDurationMs`.

**Admin read-access to other users' files.** Folder list/tree/breadcrumb routes accept `?ownerId=<id>` (admin only — non-admins are silently scoped to themselves via `effectiveOwnerId(req)`). File read routes (`/:id`, `/preview`, `/url`, `/download`, `/thumbnail`) use `readableFileWhere(req, id)` which drops the `ownerId` filter for admins. Write routes (PATCH/DELETE/upload) keep strict ownership. The frontend exposes this via `/files?as=<userId>` in `pages/Files.jsx`, with a banner and read-only UI (upload, new folder, rename, delete, share are hidden).

**Quota.** `backend/src/services/quota.service.js` is called on every size-changing operation. The chunked flow checks quota twice: at `init` (declared size) and at `complete` (actual bytes). Hard-deleting from trash decrements `usedBytes`; soft-delete does not. Replace-on-duplicate refunds the old file's bytes before charging for the new one.

**Trash retention (auto-clean).** `services/retention.service.js` `startRetentionJob()` (called from `server.js`) runs `purgeExpiredTrash()` 60s after boot and every 6h: it hard-deletes files/folders whose `trashedAt` is older than `TRASH_RETENTION_DAYS` (env, default 30; `0` disables), removing MinIO objects and refunding each owner's quota (batched per owner). It mirrors the manual hard-delete in `trash.routes.js`. `GET /api/trash` returns `retentionDays` so `pages/Trash.jsx` can show the "deleted after N days" banner.

**Thumbnails.** Generated by `sharp` for image MIME types only, asynchronously after upload completes. The thumbnail is stored under `t/...webp` in the same bucket. The frontend can't set `Authorization` on `<img src>`, so `BlobThumb` fetches the thumb via axios and renders a blob URL.

**Notifications.** `backend/src/services/notify.service.js` is a best-effort helper (never throws) used by trigger sites: public share download (notifies owner), admin role/quota/ban change (notifies target user), welcome on register and admin-created accounts. The frontend `NotificationBell` polls `/api/notifications` every 30s with React Query. The dropdown panel is portal-rendered (`react-dom` `createPortal`) into `document.body` with `useLayoutEffect` computing position from the bell's bounding rect — this avoids clipping when the bell sits in a narrow sidebar.

**Recent / Starred.** `File.starred Boolean` and `File.accessedAt DateTime?` columns drive these views. `bumpAccessed(id)` is called asynchronously (no `await`) from `/files/:id/{preview,url,download}` routes. Endpoints: `GET /api/files/recent` (top 50 by accessedAt), `GET /api/files/starred`, `POST /api/files/:id/star` (toggle).

**Video stream protection.** Video is the one media type that does *not* use a presigned MinIO URL (which would leak a publicly-fetchable link and allow trivial download). Instead: `GET /api/files/:id/stream-token` (authed) issues a short-lived JWT `{sub, fid, p:'stream'}` (`STREAM_MAX_AGE_MS = 3h`) and delivers it as a **hardened HttpOnly cookie, never in the URL** — `res.cookie('stream_tkn', jwt, { httpOnly:true, secure: prod, sameSite:'strict', path:'/api/files/<id>/stream', maxAge:3h })`, returning `{ok:true}`. `GET /api/files/:id/stream` is mounted **before** `router.use(requireAuth)`, reads the token from the `stream_tkn` cookie (`readCookie()` parses `req.headers.cookie`; no cookie-parser dep), verifies it, checks `payload.fid === id`, re-checks access with `fileAccessLevel(user, file)` on every request, and streams from MinIO honoring HTTP `Range` (206 Partial Content via `storage.service.getObjectRange` → `getPartialObject`). The cookie's per-file `path` scoping keeps multiple videos from clobbering each other. The frontend `PreviewModal` calls `FileApi.streamToken(id)` (axios `withCredentials:true`) to set the cookie, then points `<video src>` at the tokenless `…/stream` URL (same-origin, so the cookie rides along automatically). `VideoPlayer` sets `controlsList="nodownload noremoteplayback"` and blocks the context menu. **The earlier `?t=<token>` query form was removed** — a token in the URL is a 3h bearer credential that leaks via history/logs/Referer and was replayable while logged out. Keep the stream route above the `requireAuth` mount or cookie playback 401s.

**Sharing has two distinct mechanisms.** (1) *Public share links* (`Share` model, `/api/shares`) — token URLs, optional password/expiry/download-cap, optional `allowUpload` (drop-box). **A password-protected share is "locked": `GET /public/:token` returns metadata only (`locked:true`, no file name/size or folder listing); the client exchanges the password via `POST /public/:token/unlock` to get the full payload** — the listing can't be read without the password, matching the download gate. (2) *Grants* (`FileGrant`/`FolderGrant`, `/api/grants`) — share a file/folder **to a specific registered user** with a permission level; the recipient sees it under "Shared with me" (`pages/SharedWithMe.jsx`, `GET /api/grants/shared-with-me`). `backend/src/services/access.service.js` (`fileAccessLevel`, `readableFileWhere`) is the single source of truth that unifies ownership + admin + grants, and is what the stream/preview/download routes consult.

**Comments.** `Comment` model; `GET/POST /api/files/:id/comments`, `DELETE /api/files/:id/comments/:cid`. Visible to anyone with read access (owner, admin, or grantee).

**Collections.** `Collection` + `_CollectionFiles` m2m — user-defined groupings independent of the folder tree (a file can be in many collections). `/api/collections` CRUD plus `POST/DELETE /:id/files[/:fileId]`. Frontend: `pages/Collections.jsx`, `CollectionView.jsx`, `AddToCollectionModal.jsx`.

**AI: OCR + semantic search (`ai.service.js`).** Best-effort, runs async after upload (`indexFile`). OCR shells out to the `tesseract` CLI (langs `eng+vie`); PDFs are rasterized with `pdftoppm` first (capped pages). Extracted text lands in `File.ocrText` and is folded into `/api/files/search` (name OR ocrText). Embeddings use `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` (lazy-loaded singleton, cached in `TRANSFORMERS_CACHE=/app/models`), stored in `File.embedding`; `GET /api/files/semantic-search` ranks by cosine similarity. `POST /api/files/reindex` (admin) backfills. None of this throws into the request path — if a CLI is missing the file just isn't indexed.

**Real-time presence (`realtime/presence.js`).** A `ws` `WebSocketServer` attached to the same HTTP server at `/ws` (see `server.js` → `attachPresence`). The client (`frontend/src/lib/presence.js`) connects with `?token=<jwt>&fileId=<id>`; the server keeps a room per file and broadcasts the deduplicated viewer list, with ping/pong heartbeats. `PreviewModal` renders viewer avatars. nginx proxies `/ws` with the Upgrade headers; Caddy passes it through.

**WebDAV (`webdav.routes.js`).** Mounted at `/webdav` in `app.js` **before `cors()`** — the CORS middleware would otherwise strip the `DAV` header off the `OPTIONS` preflight and break discovery. Auth is HTTP Basic (username + password or an API key). Maps the user's folder tree to WebDAV collections backed by MinIO.

**Security (group B).** Rate limiting (`middleware/ratelimit.js`: `authLimiter` 20/15min on login/register/reset, `publicLimiter` on share routes — requires `app.set('trust proxy', …)` behind nginx/Caddy to rate-limit the real client IP, not the proxy). API keys (`ApiKey` model, `uk_` prefix, sha-256 hashed; `/api/keys`; `requireAuth` accepts `Authorization: Bearer uk_…` or `X-API-Key`). Audit log (`AuditLog` + `audit.service.js`, best-effort; `GET /api/audit` admin-only; `pages/Audit.jsx`). Share-access log (`ShareAccess`). Password reset (`Token` model + `mail.service.js`; `/api/auth/forgot-password` + `/reset-password`). SSRF guard on `/api/files/from-url`: `assertUrlAllowed` (scheme + `isBlockedHost` + a DNS-resolution check `resolvesToBlockedIp` that rejects hostnames resolving to private/loopback ranges) is run on the initial URL **and re-run on every redirect hop** by `fetchFollowingSafely` (manual `redirect:'manual'` loop, 5-hop cap) — a public URL can't 30x-redirect into an internal host. CSP is enabled in helmet (`app.js`) with directives compatible with Swagger UI (`'unsafe-inline'` for its scripts/styles, `upgrade-insecure-requests` disabled so dev HTTP works); since the SPA HTML is served by nginx, this CSP applies to API/Swagger/WebDAV responses. `server.js` logs a SECURITY warning if `JWT_SECRET` is weak/default; the prod compose refuses to start without it.

**Mail (`mail.service.js`).** nodemailer transport built from `SMTP_*` env; mail is lazy and best-effort (never blocks a request, never throws). `looksLikeEmail()` skips username-only accounts. Reset **and verification** links are built from `PUBLIC_APP_URL` (`sendVerifyEmail(to, token)` → `${APP_URL}/verify-email?token=…`). `SMTP_ALLOW_SELFSIGNED=true` sets `tls.rejectUnauthorized:false` for relays with self-signed certs. Dev uses **Mailpit** (`mailpit` service, web UI :8025, accepts any SMTP); prod can use **docker-mailserver** (`--profile mail`) **or any external relay via `SMTP_*`**. In practice the production deploy uses a **Gmail SMTP relay** (`smtp.gmail.com:587`, `SMTP_SECURE=false`, a 16-char Gmail *App Password* — not the account password — which requires 2-Step Verification enabled): self-hosting docker-mailserver on a residential DDNS host fails Gmail's PTR/SPF/DKIM checks, so outbound to Gmail bounces. See `docs/mail-setup.md` and the `docker-mailserver-setup.md` memory.

**Upload-from-URL.** `POST /api/files/from-url` server-side fetches a remote URL into MinIO (behind the SSRF guard above). Frontend surfaces it in the `Uploader`.

**PWA.** `frontend` ships a manifest + service worker (registered in `main.jsx`); nginx serves `sw.js` with no-cache and the manifest with the right MIME. Install/offline only work over a **secure context** — hence the HTTP-LAN fallbacks in `frontend/src/lib/uid.js` (`randomId` for `crypto.randomUUID`, `copyText` for `navigator.clipboard`) and the Caddy/HTTPS production setup. Three mobile features (Task 8):
- **Camera upload** — `Uploader` has a second `<input accept="image/*" capture="environment">`; the ref exposes `capture()` and the "Take photo" button in `Files.jsx` calls it.
- **Web Share Target** — `manifest.webmanifest` declares a `share_target` (POST multipart to `/share-target`). The **service worker** intercepts that POST *before* its GET-only guard, stashes each file as a `Response` in the `share-target` Cache, and 303-redirects to `/files?share-target=N`. `lib/shareTarget.js` `consumeSharedFiles()` reads them back into `File` objects (clearing the cache) and `Files.jsx` feeds them to `uploaderRef.add(files)`. The `activate` handler preserves the `share-target` cache; SW cache version is `uploader-v3`.
- **Offline outbox ("background sync")** — `lib/outbox.js` (IndexedDB, stores `File` directly). When `navigator.onLine === false`, `Uploader.addFiles` queues files instead of uploading; a mount + `online`-event effect flushes the queue via `chunkedUpload`. **It's page-level, not SW-replayed, on purpose: uploads are JWT-authenticated and the SW can't read the token from localStorage.** `Layout.jsx` shows an offline badge.

**Production deploy.** `docker-compose.prod.yml` layers on top of the base compose: adds a **Caddy** service (auto-HTTPS/Let's Encrypt) terminating TLS at `rabbitworld.ddns.net`, routing `/uploads/*` → MinIO (for presigned image/audio/download URLs, same-origin to avoid mixed content) and everything else → frontend nginx → backend. Backend env is overridden to the `https://` domain (incl. `MINIO_PUBLIC_ENDPOINT`); `JWT_SECRET` is required via `${JWT_SECRET:?}`. Mailpit is gated to a `dev-only` profile, docker-mailserver to a `mail` profile, so default prod = `backend caddy frontend minio postgres`. Full instructions in `docs/deploy.md`.

**Frontend layout / folder tree.** The folder tree is **not** in the sidebar nav anymore — it lives in its own collapsible column to the right of the sidebar, rendered by `Layout.jsx`'s `folderPanel(onClose, CloseIcon)` helper (only on the My Files area). Desktop: a `w-60` `<aside>` shown `md:flex`; when collapsed (state persisted via `localStorage 'treeOpen'`), a small round toggle button sits vertically centered on the sidebar's right edge (`ChevronRight`) to re-open it. Mobile (`< md`): a folder button beside the hamburger opens the tree in a **centered modal** (`mobileTreeOpen`), not the old navbar dropdown. The breadcrumb's old `ChevronDown` "Jump to a subfolder" dropdown was removed from `pages/Files.jsx` (`ChevronRight` is kept only as the breadcrumb separator). `Layout.jsx` uses **single-space indentation** — match it exactly when editing. `LayoutTree.test.jsx` covers the column/toggle/persistence/mobile-modal behavior.

**Frontend state.** Zustand stores: `store/auth.js` (auth session, persisted) and `store/theme.js` (light/dark, persisted). React Query for all server data — invalidate `['folders']`, `['folder-tree']`, `['search']`, `['trash']`, `['shares']`, `['users']`, `['notifications']`, `['file-recent']`, `['file-starred']` as appropriate after mutations. `axios` request interceptor in `api/client.js` injects the JWT; response interceptor logs out on 401.

**Dark mode.** Class-based (`darkMode: 'class'` in `tailwind.config.js`). Theme toggled via `store/theme.js` which adds/removes `.dark` on `<html>`. To avoid a light flash on first paint, an inline `<script>` in `frontend/index.html` reads `localStorage` synchronously and applies the class before the React bundle loads. The `<body>` tag has **no class attribute** — if you put one there (e.g. `class="bg-slate-50"`) any global `.dark .bg-X` override leaks into body via specificity and breaks the dark canvas. Surface palette: body `slate-950`, cards/sidebar `slate-900`, popovers/modals `slate-800`, inputs recessed to `slate-950`.

## Routing map (quick reference)

```
/api/auth              register (self-reg → email verification), login, me,
                       verify-email, resend-verification,
                       forgot-password, reset-password,
                       sessions (list), sessions/:id DELETE,
                       sessions/revoke-others, logout
/api/folders           list (?parentId=, admin ?ownerId=), tree, breadcrumb,
                       create, rename/move, soft-delete
/api/files             single-shot upload, from-url, get, rename/move/tag,
                       soft-delete, download, presigned URL, preview, thumbnail,
                       versions, recent, starred, :id/star, :id/optimize,
                       :id/stream(+stream-token), :id/progress (watch position),
                       :id/comments, bulk trash/rename/move/zip,
                       search, semantic-search, reindex(admin), duplicates,
                       analytics
/api/upload            chunked init/part/complete/resume/abort
                       init accepts replaceFileId for atomic file replacement
/api/shares            create (file or folder), list, revoke (auth)
                       + public/:token, public/:token/download,
                         public/:token/upload (drop-box when allowUpload)
/api/grants            shared-with-me, grant file/folder to a user, revoke
/api/collections       list/create/get/update/delete, add/remove files
/api/keys              list/create/revoke API keys (uk_ prefix)
/api/audit             admin: list audit log
/api/trash             list trashed, restore, empty, hard-delete a file
/api/users             /me PATCH, admin: list/create/update (role/quota/ban/password)/delete
/api/notifications     list (?unread=1), :id/read, mark-all-read, :id DELETE, clear
/webdav                WebDAV (HTTP Basic; mounted before cors())
/ws                    WebSocket presence (?token=&fileId=)
```

## Things to be careful with

- **MinIO SDK internals.** `storage.service.js` calls `initiateNewMultipartUpload`, `uploadPart`, `completeMultipartUpload`, `abortMultipartUpload` — these are documented but their argument shapes have shifted between major versions. **`uploadPart` in `minio-js` 8.x is `uploadPart(partConfig, payload)` — payload MUST be the second arg.** Putting it inside `partConfig` sends an empty body and corrupts the upload silently (the ETag becomes `d41d8cd9...` = MD5 of empty string, and the assembled object is 0 bytes with no error logged). If you upgrade `minio`, run a real chunked upload of a multi-MB file before merging and verify the MinIO object size matches.
- **Presigned URLs and Docker hostnames.** Inside the container the MinIO endpoint is `minio:9000`. That hostname can't be resolved from the user's browser, so presigned URLs **must** be signed against `MINIO_PUBLIC_ENDPOINT` (the `minioPublic` client). Setting `region: 'us-east-1'` on `minioPublic` is required — otherwise the SDK tries to GetBucketLocation against the public host from inside the container and fails with ECONNREFUSED.
- **Folder path consistency.** `Folder.path` is denormalized (e.g. `/docs/2025`). When renaming or moving a folder, *all descendants' paths must be rewritten* — `folders.routes.js` does this in a `$transaction`. Don't skip that step.
- **Cascade vs. soft-delete.** `trashedAt` is the source of truth for "in trash"; nothing is removed from MinIO until a hard-delete via `/trash/file/:id` or `/trash/empty`. Filters in folder/file list queries must always include `trashedAt: null`.
- **CORS origins.** `CORS_ORIGIN` is a comma-separated allowlist. The dev frontend (`:5173`) and Docker frontend (`:8080`) both need to be listed, or use `*`.
- **First-admin rule.** The "first registered user becomes admin" check uses `prisma.user.count()`. If you seed users in tests, account for this.
- **Notification panel positioning.** `NotificationBell` portal-renders the dropdown into `document.body` with `position: fixed` computed from the bell's `getBoundingClientRect()`. If you move the bell to a new container with a transform/overflow ancestor, fixed positioning still works — but if you remove the portal and use plain `absolute`, the panel will get clipped by the narrow sidebar.
- **Dark mode CSS pitfalls.** Don't put Tailwind classes on `<body>` in `index.html` and don't use `@apply bg-slate-X` on `body` in CSS — both leak into `.dark body` via `.dark .bg-X` global overrides and tank the dark canvas. Set body bg directly with raw color values. The `<html class="dark">` flip happens in an inline script before React loads (see `frontend/index.html`).
- **Tailwind `dark:` boundaries.** When bulk-editing classes (e.g. adding `dark:` variants via sed/perl), use negative lookbehind `(?<![:\-])` and word boundary `\b` to avoid `hover:bg-slate-100` matching `bg-slate-100` as a substring — otherwise you get `hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-800` duplicates.
- **Admin "view as user" is read-only by design.** PATCH/DELETE/upload routes still require ownership. If you add write operations on behalf of other users, gate them behind an explicit admin check (`req.user.role === 'admin'`) and consider audit logging.
- **Alpine vs. Debian base.** The backend image **must** stay on a glibc base (`node:20-bookworm-slim`). `@xenova/transformers`/onnxruntime prebuilt binaries are glibc-only and crash on musl, and OCR/video features shell out to `tesseract`/`pdftoppm`/`ffmpeg` installed via `apt`. Switching to alpine silently disables all AI/video features.
- **WebDAV must mount before `cors()`.** In `app.js`, `app.use('/webdav', …)` is intentionally above the CORS middleware — `cors()` strips the `DAV` response header from the `OPTIONS` preflight, which breaks WebDAV client discovery. Don't reorder.
- **Rate limiting behind a proxy.** `express-rate-limit` keys on the client IP, but behind nginx/Caddy every request appears to come from the proxy. `trust proxy` must be set so `X-Forwarded-For` is honored — otherwise you rate-limit the proxy globally (one user trips it for everyone).
- **Video stream route ordering.** `GET /:id/stream` is registered *before* `router.use(requireAuth)` in `files.routes.js` because it authenticates via the `stream_tkn` HttpOnly cookie (browsers can't set `Authorization` on `<video src>`). If you move it below the auth mount, cookie playback 401s. Don't reintroduce a `?t=<token>` query form (it's a shareable, replayable bearer credential in the URL) and never expose a presigned MinIO URL for video — both defeat the download protection.
- **Presigned media over HTTPS in prod.** `MINIO_PUBLIC_ENDPOINT=https://rabbitworld.ddns.net` and Caddy routes `/uploads/*` → `minio:9000`. The `parsePublicEndpoint` helper in `config/minio.js` already handles `https`/port 443. If you change the bucket name, the Caddy `/uploads/*` matcher must match the bucket path.
- **`JWT_SECRET` in prod.** `docker-compose.prod.yml` uses `${JWT_SECRET:?…}` so the stack refuses to start without one — even `build`/`config` subcommands need it interpolated (pass `JWT_SECRET=x` for a build). Don't paper over this by hardcoding a secret in the compose file.
