# Uploader — File Upload & Management

Full-stack file storage app: **React** (frontend) + **Node.js/Express** (backend) + **MinIO** (object storage) + **PostgreSQL/MySQL/SQLite** (metadata via Prisma). Ships with a one-command **production deploy** (Caddy + automatic HTTPS), **2FA**, optional **OCR + semantic search (pgvector)**, **HLS adaptive streaming**, **Whisper transcription**, **WebDAV**, **real-time presence + server push**, and **email** (Mailpit in dev, docker-mailserver in prod).

## Features

### Auth & users
- **Self-registration with email verification** — sign-up requires a real email and a confirmed password; a verification link is mailed, and login is blocked until it's clicked (resend supported). The first account auto-becomes a verified `admin`; admin-created accounts skip verification.
- **Admin approval to upload** — self-registered users can log in and browse but **can't upload until an admin approves them** (admins are notified when a new user verifies; approve/revoke from the Users page). First-user/admin-created accounts are pre-approved.
- Username **or** email login (regular usernames must be `letters/digits/. _ -`) — both go in the request's `email` field, which accepts either
- JWT auth with `admin` / `user` roles, per-user quota
- **Two-factor authentication (TOTP)** — scan a QR with any authenticator app; login becomes password + 6-digit code, with 8 single-use recovery codes (shown once, stored hashed). Disabling 2FA requires password **and** a valid code.
- **Session management** — every login is a revocable session; a "Active sessions" panel lists your devices (browser/OS, IP, last active) and lets you sign out one or all others. Changing your password signs out every other device; a reset signs out all.
- **API keys** (`uk_` prefix, hashed) for programmatic / WebDAV access
- **Password reset** by email (forgot-password → tokened reset link); confirm-password on register & password change
- Admin can create users, change roles, change quotas, reset passwords, ban/unban, delete
- Admin can browse another user's files read-only via `/files?as=<userId>`
- **Groups** (admin-managed) — add users to named groups, then share files/folders to a whole group at once
- Welcome / role-change / quota-change / ban / share-download notifications — **pushed live over WebSocket** (slow poll only as fallback)

### Files & folders
- Folder tree in its own collapsible column (round edge toggle on desktop, modal on mobile) with expand/collapse and **drag-and-drop file move**
- **Chunked / resumable upload** for large files (MinIO multipart, 8 MiB parts)
- **Upload from URL** — server-side fetch into storage (SSRF-guarded)
- **Import video from URL** — paste a link from a curated allowlist of reputable sources (YouTube, Vimeo, Dailymotion, TED, Internet Archive, Wikimedia, SoundCloud, X, Facebook, Instagram, Reddit, Twitch); the server downloads the best-quality video with `yt-dlp` (+ffmpeg) into your files, with a **live progress** indicator. Extend the allowlist via `VIDEO_IMPORT_HOSTS`.
- **Replace-on-duplicate** flow: name conflict surfaces a dialog with "apply to all remaining" checkbox; old file + MinIO object atomically replaced, quota refunded — and charged **net** of the refund, so replacing a file with one of the same size works even when you're at your limit
- File versioning, tags (chip + popover editor), full-text search, tag filter
- Preview (images w/ lightbox + EXIF, video, audio, text/markdown w/ syntax highlight) and auto-generated thumbnails (`sharp`)
- **Comments** on files (visible to anyone with read access), with **`@mentions`** — mention someone by username or by the local part of their email (`@alice` finds `alice@example.com`) and they get a notification
- **Collections** — group files across folders (a file can be in many)
- Trash bin (soft delete + restore + empty + hard delete) with **auto-clean** — items left in trash past a retention window are purged automatically (quota refunded). Both the sweep and "empty trash" **never destroy a folder you restored out of a still-trashed parent**, and a file's quota refund always covers *every* version it accumulated
- Bulk operations: trash, move, **bulk rename**, **download as ZIP**
- List view + image **grid view** (with auto-suggestion when ≥ 50% of files are images)
- **Scales to huge folders** — files are cursor-paginated (200/page, server-side sort) and the next page auto-loads on scroll (IntersectionObserver sentinel, with a "Load more" fallback), so a folder with thousands of files stays responsive. Listings also stay lean: the search-only columns (a file's full extracted OCR/transcript text and its embedding vector) are stripped from every list response, so a page of files doesn't ship megabytes the UI never renders
- Recent (recently accessed) and Starred views; **storage analytics** + **duplicate finder**

### Search & AI (optional, best-effort)
- **OCR** of images and PDFs (`tesseract` + `pdftoppm`) — extracted text is searchable
- **Semantic search** via on-device embeddings (`@xenova/transformers`, MiniLM) — no external API. On PostgreSQL the ranking runs **in the database via `pgvector`** (`vector(384)` column + HNSW index, ANN `ORDER BY <=>`); MySQL/SQLite fall back to in-process cosine
- **Whisper transcription** (opt-in, `WHISPER_ENABLED`) — videos/audio are auto-transcribed with `whisper.cpp`; the transcript becomes searchable (plain + semantic) and a `.vtt` subtitle file appears next to the video, picked up by the player automatically

### Sharing
- **Public share links** for files or folders with expiry, password (bcrypt), download cap, optional **upload drop-box** (`allowUpload`)
- **A link's limits hold even when it's opened by several people at once** — see "Data integrity" below; the download cap and the drop-box's file limit are claimed atomically, so a link capped at one download serves exactly one
- Per-link **label** (tell your links apart), **QR code** (show it to someone standing next to you), and **extend/remove expiry** after creation
- **Share to a specific user or to a group** (grants) — recipients see it under "Shared with me" (group shares marked `via "<group>"`)
- Public folder share renders a list + "Download folder as ZIP"
- **Trashing kills the share links on it** — for a file *or* a folder. The link stops resolving, stops serving bytes, stops disclosing the target's name, and (for a drop-box) stops accepting uploads, so moving something to the trash is a real "un-share it"
- **Trashing revokes the people you shared it with, too** — the same rule now covers grants, not just public links: once you delete a shared file or folder, the people (and groups) you shared it with lose access to it, exactly as "Shared with me" already implied by hiding it. Restoring it gives the access back
- Owner notified when shared content is downloaded; per-share access log

### Real-time & access
- **Presence**: live viewer avatars on a file preview (WebSocket `/ws`)
- **Server push** on the same socket — notifications and file changes (upload/rename/move/trash from another device or a drop-box) refresh open tabs instantly
- **Collaborative editing** of text/markdown files (Yjs CRDT over `/yjs`) — multiple people edit at once with colored cursors; saves land as a normal file version, deduplicated by checksum. Requires **edit** access, not just read
- **WebDAV** mount (`/webdav`, HTTP Basic / API key) — browse storage as a network drive
- **Protected video streaming**: authenticated `/stream` endpoint with HTTP Range + a short-lived **HttpOnly cookie** credential (never in the URL, so it can't be shared or replayed; MinIO URL never exposed, `nodownload`)
- **HLS adaptive streaming** (opt-in, `HLS_ENABLED`) — large videos are background-transcoded to a 720p/480p ladder; the player (`hls.js`, native on Safari) adapts to the connection and falls back to the plain stream. Segments are protected by the same stream cookie

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
- SSRF guard on upload-from-URL (DNS-resolution check, **re-validated on every redirect hop**) — the blocked set covers the ranges that are *internal in practice*, not just the textbook private ones: carrier-grade NAT (`100.64/10`, which is Tailscale's entire address space and a common Kubernetes pod network), the whole of `0.0.0.0/8` (on Linux `0.1.2.3` reaches the local host, so blocking only the exact `0.0.0.0` left a plain loopback bypass), and the IETF special-use and benchmarking ranges
- **Content-Security-Policy** enabled (helmet); password-protected shares don't reveal their contents until unlocked
- **Revocable sessions enforced on WebSockets too** — every socket (`/ws`, `/yjs`, `/gws`) validates the session row and rejects purpose-scoped tokens, so "log out everywhere" also cuts realtime
- **Only a real session token authenticates a request** — the short-lived tokens issued mid-2FA and for video playback are signed with the same key, so the REST middleware rejects anything carrying a purpose claim rather than relying on those tokens happening to omit a session id; the check runs before any database lookup, so an unusable token costs nothing
- **Folder shares are scoped to their owner** — folder paths aren't unique across accounts (two people can both have `/docs`), so grants match on owner as well as path and can't spill onto a same-named folder belonging to someone else
- **Quota can't be tricked** — the chunked upload enforces its declared size on every part (not just at the end, so unpaid bytes never accumulate in storage), and refunds floor `usedBytes` at zero so overlapping deletes can't drive it negative into unlimited storage
- **The quota holds when uploads arrive at once** — checking the remaining space and then charging for the upload were two separate steps with the whole transfer in between, so simultaneous uploads all measured the same starting balance, all decided they fit, and all committed: ten parallel 200-byte uploads against a 1000-byte limit stored 2000 bytes. This needed no trickery — the uploader sends several files at once, so ordinary use overshot — and an upload-request link reaches the same path with no login at all, meaning a stranger holding the link could push the owner arbitrarily past their limit. Space is now claimed in a single step that only succeeds if it still fits, applied to every way in: the web uploader, large chunked uploads, uploads by URL, video imports, new versions, editor saves, the WebDAV mount and anonymous upload links. A claim that doesn't turn into a stored file is given back
- **A large upload finishes exactly once** — the step that turns a completed chunked upload into a stored file checked whether the upload was already finished, then did the whole of the work (assembling the parts, charging the quota, creating the file) before marking it done. Anything arriving in that window started the same work over again — and the thing that arrives in that window is the uploader's own retry, sent whenever finishing a big file times out or the connection drops. Measured against a real server: five retries of one upload created **five copies of the file and charged five times the bytes**, and the copies all pointed at the same stored object, so deleting any one of them pulled the content out from under the rest. The upload is now claimed in a single step before any work begins, so one attempt wins and the others are told it's already finished — the file is stored once, billed once, and the retry is harmless
- **The WebDAV drive can't be used to smuggle a path into a name** — every route in the web app checks that a stored name is a single name rather than a disguised path, but the WebDAV mount checked nothing, and it decodes the request path in a way that hides the disguise: `%5C` (a backslash, which Windows drives and the ZIP format both read as a folder separator) and even a null byte arrived intact. Writing a file called `a\b.txt` produced a row a mounted drive could never open or delete again while it stayed counted against the quota; creating a folder that way forged its position into an unrelated part of the tree, where an unrelated delete would sweep it away and restoring couldn't bring it back; and either one rode into the next ZIP download as an entry that escapes the extraction folder. A null byte was answered with a raw server error. Uploads, folder creation and renames over WebDAV now refuse these with a clear error, exactly as the web app does, while ordinary names keep working
- **A comment can't fan out** — `@mentions` are capped per comment, so one post can't turn into hundreds of user lookups or notify half the instance
- **A two-factor recovery code is spent exactly once** — the codes are the way back in when an authenticator is lost, and they're the credential most likely to leak in bulk (they're handed over as a printable block that ends up in notes and password managers), so single-use is the whole point of issuing eight of them. Consuming one used to be a read-then-write, which broke in both directions under concurrency: the *same* code presented twice at the same instant was accepted twice — a second-factor bypass — while two *different* codes used at once left one of them still valid after it had already logged someone in. The consume is now a conditional write, so a code is either spent or refused
- **A password-reset link works exactly once** — the "already used" stamp is the whole of what stops a reset link being replayed, and it was read and then written as two separate steps, with the slow work of hashing the new password sitting between them. Anything arriving in that window passed the same "not used yet" check: measured against a real server, five resets submitted together on one link were **all accepted**, and whichever finished last silently decided the account's password while the other four were each told their reset had succeeded — so the person who ends up holding the account isn't necessarily the one who asked for the reset. The verification link had the same shape, handing out a working login per attempt from a single email. Both are now claimed in one conditional step, so one caller wins and the rest get the same "invalid or expired" answer a genuinely spent link gives
- **Collections can't be used to read someone else's files** — a collection is yours, but its contents are a join table, so adding a file checks that *you own it*; you can't name a stranger's file id and have the listing hand back its contents (including extracted OCR text)
- **Resetting a password cuts off API keys too, not just logins** — a password reset exists for one situation: the account may be in someone else's hands, and everything they hold has to stop working. It dropped every login session, but an API key is a *second* kind of credential — it's presented as a header, carries no session, and has no expiry of its own — so nothing in the session machinery touched it. That made a key strictly harder to revoke than a password: someone who reached the account for even a moment could mint one, and it kept full read/write access to every file after the owner had recovered the account and been told they were safe. Nothing in the recovery flow so much as mentions that a key exists, so there was no prompt to go looking. Both credential resets — recovering your own account, and an admin setting someone's password to take control back — now revoke the account's keys as well, leaving them listed as revoked so the owner can *see* what was cut off. Routinely changing your own password deliberately doesn't: that's hygiene, not recovery, and it shouldn't break your scripts and integrations
- **The last administrator can't be demoted** — deleting a user already refused to remove the last admin, because the consequence can't be undone from inside the app: the rule that grants the first account admin rights only fires on a completely empty database, so once the last one is gone, every administrative screen — user management, approving new sign-ups, groups, the audit log — is locked for good and the only way back is editing the database by hand. Changing someone's *role* had no such check, so the exact state the delete refuses to create was one role change away, and reachable by accident rather than by attack: a lone admin tidying up their own account could demote themselves (something delete explicitly forbids), or two admins could demote each other with nothing unusual happening in between. Demoting an admin while another remains still works exactly as before
- **A push-notification registration belongs to one account** — browsers register for push under an endpoint that's unique across the whole system, and re-registering used to overwrite whoever the endpoint was recorded against, so the endpoint rather than the account decided who owned it and the last person to present it won. Since notifications are delivered with their real text, taking over someone's registration quietly redirected their alerts — the name of a file just shared with them or dropped in their upload folder, the first line of a comment or a mention, a group name, whether their account was approved or banned — to another person's browser, while theirs simply went quiet. Neither side is told, and nothing in the app lists who a registration belongs to. A registration is now claimed once: your own browser refreshing its keys still works, and a device that genuinely changes hands moves over only after the previous owner unsubscribes
- Refuses to start in prod without a strong `JWT_SECRET`, `POSTGRES_PASSWORD` or MinIO credentials; datastore ports are closed in prod; redacted structured logs

### Data integrity
- **An interrupted upload is refused, never half-stored** — completing a chunked upload requires every part to be present and the bytes to actually reach the declared size, so a missing chunk fails loudly instead of assembling a file that looks fine but won't open
- **Parts can't be lost to a retry** — the part list is written with a compare-and-set, so overlapping or retried chunk uploads can't drop each other's entries
- **Empty files upload like any other** — object storage can't hold a zero-byte *part*, so a 0-byte file is sent as no parts at all and the empty object is written directly; every file goes through the chunked path, so treating "no parts" as an error made empty files impossible to upload rather than merely unusual
- **A new version updates the file's fingerprint** — uploading a version rewrites the checksum on both the file and the version row, so the duplicate finder groups by what a file *currently* holds, and the collaborative editor's "unchanged, skip the save" check can't mistake fresh content for content it already saved and drop your next edit
- **Overwriting a video drops its old renditions** — adaptive-streaming segments are keyed by file id, so an overwrite that left them in place would keep playing the *previous* video under the new file's name; every path that replaces content (new version, replace-on-duplicate, WebDAV overwrite, delete) clears them
- **Trash auto-clean won't take a folder you rescued** — restoring a folder out of a long-trashed parent keeps it, even though deleting the parent would otherwise cascade it away; the parent waits for a later sweep
- **Restoring a folder rescues its contents too, not just the folder** — "restore" deliberately clears only the flag on what you selected: restoring a folder brings the folder back but leaves the files inside still marked deleted, because a folder you restore may well be one you want only part of back. That left those files in a state nothing accounted for — the folder was live and listed again, you'd open it and find it empty, and reasonably assume the contents were still on their way. Thirty days after the *original* delete, the auto-clean would then destroy them, files and stored bytes both, out of a folder sitting in plain view; emptying the trash by hand did the same thing immediately. Both now leave a deleted file alone while the folder holding it is live, and only count the bytes they actually reclaimed. Deleting one named file from the trash still works exactly as asked
- **Video seeking serves the bytes it claims** — `Range` requests (including the `bytes=-500` suffix form) are parsed against the real object size, so a seek can't be answered with the wrong region under a correct-looking header
- **A file's older versions are billed and reclaimed as one** — every version keeps its own stored copy, so deleting or overwriting a file refunds and removes *all* of them; a WebDAV overwrite collapses the history rather than leaving earlier versions charged for storage nothing points at
- **Optimising a video keeps the books straight** — the "make this video start faster" pass rewrites the stored file (same content, smaller container) and then has to correct the space it takes up. It did that by adjusting the account total directly, without the floor that keeps the figure from going below zero — and a negative total makes every later size check pass, quietly turning the quota off for that account with no way to notice or undo it. It also updated the file's own size but not its version record, and deleting a file refunds what the *version records* say, so every optimised video left the total permanently wrong once it was eventually deleted. Both halves now go through the same accounting the rest of the app uses
- **Deleting an account takes its storage with it** — the file records are the only index of what's in object storage, and they disappear with the account, so the objects (originals, thumbnails, video renditions) are removed first; otherwise they'd linger with nothing left to attribute them to
- **A trashed file accepts no new content** — uploading a version to (or re-optimising) a file that's in the trash charged the owner for bytes hanging off a row they can't see and never chose to keep, and the retention sweep could delete it moments later; both routes now refuse, matching every other write path
- **Two folders can't end up sharing one path** — a folder's path is how the app identifies its whole subtree, so a rename that landed one folder on a live sibling's path made deletes and renames reach into the *other* subtree; the WebDAV mount is held to the same rule the web UI already enforced
- **A share link's cap counts every use, including simultaneous ones** — the download limit is the difference between "a link for one person" and "a link for everyone it gets forwarded to", but it was checked when the request arrived and only counted when the transfer *finished*. Everything arriving in between — a browser fetching in parallel, or two people opening a forwarded link at the same moment — read the same untouched number and was let through, so a link capped at one download served as many as showed up together, and the counter the owner sees reported fewer than had actually left the server. The drop-box's file limit had the same shape and mattered more, because that endpoint takes no sign-in at all: it was the only thing bounding how many files a stranger holding an upload link could put into your storage. Both are now claimed before a single byte moves, so the limit is the limit; a refused or failed upload hands its slot back rather than burning it
- **Moving a file onto an existing name replaces it, rather than hiding it** — a WebDAV move used to leave two live files under one name, after which which one a client read, overwrote or deleted came down to row order, and the other stayed billed but unreachable; the displaced file now goes to the trash (where its bytes are still refundable) or the move is refused outright
- **Restoring from the trash puts the item somewhere you can reach it** — restoring a file out of a folder that is itself still in the trash used to clear only the file's own flag, leaving it live inside a hidden folder: gone from the trash listing, unreachable in My Files, and still counted against the quota; the restore now brings back the folders above it too, while deliberately leaving that folder's *other* contents in the trash
- **Restoring can't put two things on one name** — every other place that picks a name refuses to land two live items on it, and those checks deliberately ignore what's in the trash: a deleted folder keeps its name and must not block you re-creating one. Restore had no check at all, which turned that carve-out into the way in — delete `docs`, make a new `docs`, then restore the old one from the trash, and two live folders now claim the same path. A folder's path is how the app identifies its entire subtree, so from then on deleting one `docs` trashed the *other's* files and renaming one rewrote the other's contents into a tree whose folders no longer matched their parents. The file-and-folder version is worse: a folder always wins when a WebDAV client resolves a path, so the restored file became unreadable *and* undeletable from a mounted drive while still counted against the quota. Restoring a *file* could trigger it too, since that also brings back the folders above it. A restore that would collide is now held back and reported, and the item stays in the trash so you can rename the thing in the way and try again; two files sharing a name is still fine, exactly as uploading two files with one name always was
- **A file in the trash can't be renamed or moved** — the rename/move route wrote to trashed files, so a move relocated something the listing hides (it resurfaced on restore in a folder nobody chose) and a rename changed the entry out from under whoever was looking for it in the trash; starring and re-deleting still work on a trashed file, as they must
- **A folder can't be moved into a folder that's in the trash** — creating a folder under a trashed parent was already refused, but *moving* one there wasn't, and moving is what the folder tree's drag-and-drop does; the moved folder and everything beneath it would land live inside a hidden parent — absent from My Files, absent from the trash listing, still counted against the quota, with nothing reporting an error
- **A public folder link dies with its folder** — this already held for single-file links, but a folder link kept resolving after the folder was trashed: it still disclosed the folder's name and path, and an upload-request link still *accepted* anonymous uploads, filing them live inside a deleted folder where the owner could reach them from neither screen
- **The approval gate covers the WebDAV mount too** — every upload route in the web app refuses an account an admin hasn't approved yet, but the WebDAV drive had no such check, so the same account could mount it in Finder/Explorer and write as much as its quota allowed; creating content over WebDAV is now held to the same rule, while browsing, deleting and moving stay open as they are in the UI
- **A long upload can't land in a folder that was deleted while it ran** — a chunked upload can take hours, and the destination folder was only checked when it started; trashing that folder mid-upload used to file the finished file live inside a hidden parent, absent from both My Files and the trash while still counted against the quota. The file now lands at the top level, where it's visible and can be moved
- **Seeing who else is viewing a file requires being able to open it** — the live "who's here" indicator broadcasts each viewer's name and email to everyone in the room, but joining a room was gated on nothing more than being logged in, so anyone holding a file id could collect the identities of people viewing a file they had no access to; joining now goes through the same permission check as opening the file
- **A file in the trash can't be shared with anyone** — deleting something is how you stop sharing it here, and every *reading* path already honoured that: public links stop resolving, existing grants stop working, and the item leaves "Shared with me". Handing out a *new* grant on a trashed file was still allowed, and that grant isn't inert — it's a row waiting for the item to come back. Restoring something is ordinary housekeeping ("I deleted that by mistake"), and nothing about it suggests it also switches on access the owner never granted while the file was visible; the Trash screen has a restore button and says nothing about sharing, so there's no prompt to re-check afterwards. On a folder it reaches further still, since a folder grant covers everything beneath it. An admin can reach any user's file here, so this was also the route by which someone else could be given standing access to a file its owner believes is gone. Sharing a trashed file or folder — to a person or a group — is now refused
- **Deleting a shared file actually cuts off the people you shared it with** — trashing already killed *public links*, and "Shared with me" already stopped listing the item, so deleting something looked like un-sharing it from both ends. The access itself outlived the listing: anyone you'd shared with who still had the id — ids travel in links and pasted URLs — could keep opening the file, downloading its bytes, and getting a direct storage URL for it, and could still read the extracted text of the whole document, while the owner watched it sit in their trash. Grants (to a person *or* a group, on the file or on a folder above it) now stop resolving the moment the item is trashed, and start working again when it's restored. You keep full access to your own trashed files, which is what the Trash screen needs
- **A file and a folder can't occupy the same name in the same place** — nothing stopped a folder being created over a file (or a file being written over a folder), and a folder always wins when a WebDAV client resolves a path: the file underneath became unreadable *and* undeletable from any mounted drive, while staying live and counted against the quota, and a folder listing showed the one name twice. Every route that can pick a name — creating or renaming a folder, renaming or moving a file, all four upload paths, upload-request links, and the WebDAV mount's `MKCOL`/`PUT`/`MOVE` — now refuses to put the two kinds on one name. A long chunked upload is the one exception: if a folder claims the name while its parts are still uploading, the finished file is filed under a suffixed name rather than being rejected after the bytes are already stored and paid for
- **Renaming a file onto another file's name is refused** — two files under one name in one folder left a WebDAV client picking between them by row order, with the loser billed but unreachable; the same rule the WebDAV move already followed now covers the web app's rename. Bulk rename and bulk move skip just the clashing items and report how many, so one collision can't lose a 200-file batch. Uploading two files with the same name is still allowed, as it always was — both stay visible in the file list, and the uploader offers to replace instead
- **A name can't smuggle a path into itself** — a folder's location is stored as a path built by joining folder *names*, so a name that contained a `/` forged one. A folder called `work/reports/archive` was created at the top level yet claimed a position deep inside another tree: the genuine folder at that spot could then never be created (it collided with something that wasn't there), and deleting the unrelated `work` folder swept the forged one into the trash, where restoring couldn't bring it back. A *file* named `sub/evil.txt` was worse in a quieter way — a WebDAV client could no longer resolve it at all, so it sat live and billed but unreadable and undeletable from a mounted drive — and any name containing `../` was written straight into a ZIP download as an entry that escapes the extraction folder. Names typed by a person (creating or renaming a folder, renaming a file, starting a chunked upload) are now rejected with a clear message; a filename that merely *arrives* with an upload — a browser's multipart field, an upload-request link's submission — is reduced to its last segment instead, since the bytes are already stored and clients put paths there routinely. ZIP downloads sanitise on the way out as well, so files named before this rule existed can't ship a traversing entry either. Names the server *derives* are covered too: importing from a URL looked safe because it already takes the last path segment, but a percent-encoded backslash survives that (`%2e%2e%5C%2e%2e%5Cx.txt` was stored literally as `..\..\x.txt`), and a backslash is a separator to Windows WebDAV clients and to the ZIP format alike

### Storage / infra
- Swappable database: switch `DB_PROVIDER` between `postgresql` / `mysql` / `sqlite` (Postgres ships as `pgvector/pgvector:pg16` for semantic search)
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
- MinIO console: <http://localhost:9001> (login: `minioadmin` / `minioadmin@510`)

> These are **development defaults only**, published to your host for convenience.
> The production overlay requires real credentials and closes every one of these
> ports except Caddy's 80/443 — see [Production deploy](#production-deploy-caddy--automatic-https).

The first account you register becomes `admin`. Versioned migrations are applied automatically on container start via `prisma migrate deploy`.

The dev stack also runs **Mailpit** — outgoing mail (e.g. password resets) is caught and viewable at <http://localhost:8025> (nothing leaves the machine).

## Production deploy (Caddy + automatic HTTPS)

`docker-compose.prod.yml` adds a Caddy reverse proxy that terminates TLS and obtains/renews Let's Encrypt certificates automatically. It currently targets the domain **`rabbitworld.ddns.net`** (edit `Caddyfile` + the prod env to change it).

```bash
cp docs/prod-env.example.txt .env  # annotated template — fill in the REQUIRED values
                                   # (.env.prod.example is the same contract, terser)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### Required secrets (prod refuses to start without them)

The base compose ships dev defaults so `docker compose up` works out of the box.
The prod overlay declares these as `${VAR:?}`, so an unset value aborts the
command instead of silently deploying a publicly-known password:

```
JWT_SECRET             openssl rand -base64 48
POSTGRES_PASSWORD      openssl rand -base64 32
MINIO_ROOT_USER        e.g. uploader-prod (not `minioadmin`)
MINIO_ROOT_PASSWORD    openssl rand -base64 32
```

The backend's `DATABASE_URL` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` interpolate
these **same** variables, so rotating a password updates the server and its client
together — don't set them in two places.

> **Rotating on an existing deployment:** the Postgres and MinIO data volumes were
> initialised with the old credentials. `POSTGRES_PASSWORD` only takes effect on a
> *fresh* volume, so changing it on a running stack requires an `ALTER USER` inside
> the DB (or a dump/restore); the same applies to MinIO's root user. Plan this
> before the first public deploy, not after.

### Ports exposed in production

Only Caddy's **80** and **443** reach the host. The prod overlay drops the base
compose's `5432` (Postgres), `9000`/`9001` (MinIO), `4000` (backend) and `8080`
(frontend nginx) — those services still talk to each other over the Docker network.
Verify before going live:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep published
# expect only: 80, 443, 443/udp
```

Note this uses `ports: !override []`, **not** `ports: []` — Compose *merges* list
fields across overlay files, so a plain empty list leaves the published ports intact.

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

The script also toggles PostgreSQL-only schema lines (tagged `///pg-only`, e.g. the
`pgvector` embedding column) — semantic search transparently falls back to in-process
cosine on MySQL/SQLite.

### Required env vars

```
DATABASE_URL                      Prisma connection string (matches DB_PROVIDER)
MINIO_ENDPOINT / MINIO_PORT       Internal MinIO host (e.g. `minio` in Docker, `localhost` standalone)
MINIO_PUBLIC_ENDPOINT             Browser-reachable URL for presigned URLs (e.g. http://localhost:9000)
MINIO_ACCESS_KEY / MINIO_SECRET_KEY
                                  in Docker these interpolate MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
                                  so the server and its client rotate together
MINIO_BUCKET                      defaults to `uploads`
JWT_SECRET                        rotate this in production (prod refuses weak/default values)

# Docker compose secrets — dev defaults exist, prod REFUSES to start without these
POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
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

# Media (optional, CPU-heavy — both default OFF; one job at a time)
HLS_ENABLED / HLS_MIN_MB          background-transcode videos ≥ N MB (default 50) to HLS
WHISPER_ENABLED / WHISPER_MODEL / WHISPER_LANG
                                  auto-transcribe video/audio (model `base` by default,
                                  downloaded lazily on first use)

# Video import (yt-dlp)
VIDEO_IMPORT_HOSTS                extra comma-separated hosts for the curated allowlist
YTDLP_TIMEOUT_MS                  stuck-process safety net (default 2h)
```

> **Note:** the backend Docker image is **Debian-based** (`node:20-bookworm-slim`) and installs `tesseract-ocr`, `poppler-utils`, `ffmpeg`, `yt-dlp`, and a compiled `whisper-cli` so OCR, semantic search, video posters, video import, HLS, and transcription work out of the box. Running on an alpine/musl base disables these. The Postgres container uses the **`pgvector/pgvector:pg16`** image — don't swap it for plain `postgres` (the pgvector migration would fail).

## Repo layout

```
backend/                Express + Prisma + MinIO SDK
  prisma/schema.prisma  Multi-provider data model (User, Session, Folder, File,
                        FileVersion, Tag, Share, ShareAccess, Group, GroupMember,
                        FileGrant, FolderGrant, Comment, Collection, UploadSession,
                        Notification, AuditLog, ApiKey, Token, WatchProgress)
  prisma/migrations/    Versioned SQL migrations (applied at container start)
  scripts/switch-db.js  Rewrites the `provider` line (+ toggles ///pg-only fields)
  src/
    config/             env, prisma client, minio (internal + public clients), logger
    middleware/         auth (requireAuth + API keys), error handler, rate limiting
    realtime/           wsauth.js (shared socket handshake auth — session +
                        purpose-claim checks), presence.js (viewer presence at
                        /ws), bus.js (server push), collab.js (Yjs rooms at
                        /yjs), games.js (arcade at /gws — currently unmounted)
    routes/             auth, files, folders, upload, shares, grants, groups,
                        collections, trash, users, notifications, keys, audit,
                        push (Web Push), webdav
    services/           storage (minio), thumbnail, video, media, hls, transcribe,
                        youtube (yt-dlp), quota, notify, push, mail, ai (OCR +
                        embeddings + pgvector), totp, session, retention,
                        checksum, audit, games/ (per-game rule engines),
                        access (grants — single source of truth, incl. groups)
    utils/              http error helpers, asyncHandler, listquery (pagination),
                        vector (pgvector helpers), range (HTTP Range parsing),
                        mentions (@mention parsing + lookup),
                        foldercascade (which folders a bulk delete may safely
                        remove — Folder.parent cascades, so this is shared by
                        the retention sweep and "empty trash")
  Dockerfile            Debian base; installs tesseract/poppler/ffmpeg/yt-dlp,
                        compiles whisper-cli; migrate + serve

frontend/               React + Vite + Tailwind + React Query + Zustand (PWA)
  index.html            inline theme-init script (avoids dark-mode flash)
  nginx.conf            serves the SPA; proxies /api, /webdav, /ws to the backend
  src/
    api/                axios client + endpoints, chunked upload (fetch streaming)
    components/         Layout, Uploader, FileRow, FolderTree, Dialog (imperative),
                        PreviewModal, VideoPlayer, AudioPlayer, ImageLightbox,
                        TextPreview, CollabEditor (CodeMirror + Yjs, lazy),
                        ShareModal, AddToCollectionModal, BulkRenameModal,
                        CommandPalette, NotificationBell, games/ (arcade UI)
    pages/              Login (2FA step), Register, VerifyEmail, Forgot/ResetPassword,
                        Files, Recent, Starred, Trash, Shares, SharedWithMe,
                        Shared (public), Collections, CollectionView, Duplicates,
                        Stats, Audit, Profile (2FA + sessions), Users (admin + groups),
                        Games (route currently commented out)
    locales/            en.json / vi.json (kept at strict key parity)
    store/              auth, theme, locale (all zustand, persisted)
    lib/                format helpers, presence (WS client + server events),
                        i18n (react-i18next, sync init), push (Web Push opt-in),
                        uid (secure-ctx fallbacks), outbox, shareTarget

docker-compose.yml      Postgres + MinIO + backend + frontend + Mailpit (dev)
docker-compose.prod.yml Caddy (HTTPS) + prod env + optional docker-mailserver
Caddyfile               reverse proxy / automatic TLS for the production domain
docs/                   deploy.md, mail-setup.md, dns-mail.md, port.md,
                        prod-env.example.txt (annotated .env template)
```

## Routing map

```
/api/auth              register, me, verify-email, reset-password,
                       login  {email, password} — `email` also takes a
                              plain username
                       forgot-password / resend-verification  {identifier}
                       2fa/verify (login step), 2fa/setup, 2fa/enable,
                       2fa/disable,
                       sessions (list / revoke / revoke-others), logout
/api/folders           list (?parentId=, admin ?ownerId=; files cursor-paginated
                       ?cursor=&take=&sort=&dir= → nextCursor/total), tree,
                       breadcrumb, create, rename/move, soft-delete
/api/files             single-shot upload, from-url, from-youtube (yt-dlp),
                       get, rename/move/tag, soft-delete, download,
                       presigned URL (?inline=1 for preview),
                       preview stream, thumbnail, versions, recent, starred,
                       :id/star (toggle), :id/optimize, :id/comments,
                       :id/stream (+ :id/stream-token),
                       :id/stream/hls/:name (HLS), :id/progress,
                       bulk trash/rename/move/zip,
                       search (q + tag + OCR), semantic-search (pgvector),
                       reindex (admin), duplicates, analytics
/api/upload            chunked init (with optional replaceFileId) / part /
                       complete / resume / abort
/api/shares            create (file or folder, +label), list,
                       :id PATCH (label / extend expiry), revoke
                       + public/:token, public/:token/unlock (password),
                         public/:token/download, public/:token/upload (drop-box)
/api/grants            shared-with-me (direct + via group),
                       grant file/folder to a user or group, revoke
/api/groups            list; admin: create/rename/delete, add/remove members
/api/collections       list/create/get/update/delete, add/remove files
/api/keys              list / create / revoke API keys (uk_ prefix)
/api/audit             admin: list audit log
/api/trash             list trashed, restore, empty, hard-delete a file
/api/users             /me PATCH (name + password)
                       admin: list, create (with role/quota), update
                       (role/quota/ban/approve/name/password), delete
/api/notifications     list (?unread=1, ?limit=N), :id/read, mark-all-read,
                       :id DELETE, clear (delete all)
/webdav                WebDAV (HTTP Basic / API key)
/ws                    WebSocket presence + server push (?token=&fileId=)
/yjs/:fileId           WebSocket Yjs collab room (requires edit access; ?token=)
/gws                   WebSocket games arcade (?token=) — currently disabled;
                       attachGames() is commented out in server.js
/api/files/:id/collab-save
                       save collaborative editor text as a new FileVersion
```

All three sockets authenticate through `realtime/wsauth.js` — a live session row
plus a real session token (purpose-scoped 2FA/stream tokens are rejected).

Interactive API docs (Swagger UI) are served at `/api/docs`.

## Tests

```bash
cd backend  && npm test      # unit + Supertest — no database needed
cd backend  && npm run lint  # eslint, --max-warnings 0
cd frontend && npm test      # Vitest + React Testing Library
cd frontend && npm run lint  # eslint, --max-warnings 0
```

Both packages lint as a **hard gate** (`--max-warnings 0`) with a lenient flat
config that targets real defects rather than style. CI
(`.github/workflows/ci.yml`) runs backend lint + test, the integration suite
against a real Postgres, and frontend lint + test + build.

**Integration suite — needs a real PostgreSQL.** `backend/test/integration/**`
exercises the routes against a live database, covering the things that only
break against real SQL and real cascades: quota bookkeeping (net-cost replace,
the per-part byte ceiling, the floor-at-zero refund, refunding *every* version),
chunked-upload completeness (missing parts, short totals, concurrent parts, the
10000-part cap, and the 0-byte file that legitimately has none), comment
@mentions, owner-scoped folder grants, trashed-file share links, the
folder-cascade safety shared by the retention sweep and "empty trash", the
WebDAV overwrite's version collapse and net-cost quota check, owner-scoped
collection membership, the search-only columns being kept out of every list
response, the object cleanup a user deletion owes before its cascade destroys
the only record of what was stored, folder sibling-name uniqueness, the
case-tolerant credential lookup, the owner-scoping of bulk move, the reindex
admin gate, the WebDAV MOVE collision rules, the refusal to write new content to
a trashed file, the ancestor restore that keeps a rescued item reachable, the
refusal to rename or move a trashed one, the public folder share that dies with
its folder, the refusal to move a folder under a trashed parent, the
admin-approval gate on the WebDAV write verbs, the destination folder re-checked
when a chunked upload completes, the read-access check a presence room owes
before it broadcasts viewers' names and addresses, and the grant access that has
to end when a shared file or folder is trashed (while the owner keeps theirs),
the one-name-one-resource rule that keeps a file and a folder off the same
path, the one-path-segment rule that stops a name forging a path, the two
delete paths that must leave a deleted file alone while the folder holding it is
live (and refund only what they actually removed), the single-use guarantee
a two-factor recovery code owes under concurrency, the quota that has to hold
when uploads arrive simultaneously (single-shot, chunked and the anonymous
upload link), the video-optimise pass that must not drive the usage counter
negative or leave the version record behind, the API keys a password reset has
to revoke alongside the login sessions (and the routine password change that
deliberately keeps them), the refusal to write a new grant against a trashed
file or folder, the once-only guarantee a chunked upload's completion owes when
the client retries it, the one-path-segment rule applied to the WebDAV
mount's own write verbs, the one-name-one-resource rule that a restore from the
trash owes just as every other name-choosing path does, and the single-use
guarantee a password-reset (and email-verification) link owes under
concurrency, the per-link download and upload caps a public share link owes when
it is opened by several people at once, the refusal to demote the last
administrator, and the rule that a push-notification registration belongs to one
account and can't be claimed out from under it. It is excluded from
`npm test` by `vitest.config.js`, which is why the unit suite needs no database.

Thirty-five files: `files-access.test.js`, `upload-replace.test.js`,
`retention.test.js`, `retention-restored-file.test.js`,
`trash-empty-restored-file.test.js`, `recovery-code-reuse.test.js`,
`webdav-overwrite.test.js`, `webdav-move.test.js`,
`collections.test.js`, `user-delete.test.js`, `folder-uniqueness.test.js`,
`auth-credential.test.js`, `bulk-move.test.js`, `reindex.test.js`,
`trashed-writes.test.js`, `trash-restore.test.js`,
`file-patch-trashed.test.js`, `share-folder-trashed.test.js`,
`folder-move-trashed-parent.test.js`, `upload-gates.test.js`,
`presence-access.test.js`, `trashed-grant-access.test.js`,
`name-collision.test.js`, `name-segment.test.js`,
`quota-race.test.js`, `optimize-quota.test.js`,
`credential-reset-apikeys.test.js`, `grant-trashed-target.test.js`,
`upload-complete-race.test.js`, `webdav-name-segment.test.js`,
`trash-restore-collision.test.js`, `reset-token-reuse.test.js`,
`share-cap-race.test.js`, `last-admin-role.test.js`,
`push-subscribe-owner.test.js`.

```bash
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -e POSTGRES_DB=test --name uploader-test-db pgvector/pgvector:pg16
cd backend
TEST_DATABASE_URL=postgresql://test:test@localhost:55432/test npm run test:integration
```

Point `TEST_DATABASE_URL` at a **throwaway database only** — the helper
TRUNCATEs every table between tests (and refuses URLs containing
`prod`/`production`/`live`).

## See also

- `.claude/CLAUDE.md` — architecture notes for AI-assisted development (covers MinIO SDK version quirks, the two-client pattern for presigned URLs, dark-mode CSS pitfalls, admin read-as-user semantics, video-stream protection, WebDAV/CORS ordering, and the production Caddy setup).
- `docs/deploy.md` — production deployment (Caddy + HTTPS, hardening).
- `docs/mail-setup.md` — email in dev (Mailpit) and prod (docker-mailserver / SMTP relay).
