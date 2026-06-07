# Task 4 — Ý tưởng phát triển tiếp

Dựa trên hiện trạng app (file storage + MinIO + AI OCR/semantic + grants + shares +
WebDAV + presence + email verification), các hướng phát triển tiếp, xếp theo nhóm và
độ ưu tiên.

## 🔥 Nên làm sớm (lấp lỗ hổng đang có)

### 1. Two-Factor Authentication (TOTP)
Đã có email verification rồi, bước tự nhiên tiếp theo là 2FA. Dùng `otplib` + QR code,
thêm cột `User.totpSecret` / `User.totpEnabled`. Đặc biệt quan trọng vì app đang chạy
production công khai trên internet.

### 2. Refresh token / session management — ✅ ĐÃ XONG
Hiện JWT là bearer 7 ngày, không revoke được. Thêm bảng `Session`, cho phép user xem
"các thiết bị đang đăng nhập" và logout từ xa. Khi đổi mật khẩu thì revoke hết session cũ.

**Đã triển khai:**
- Model `Session` (`schema.prisma`) + migration `20260607120000_add_sessions`. JWT giờ mang
  thêm claim `sid`; `requireAuth` (`middleware/auth.js`) từ chối token nếu session bị revoke
  hoặc hết hạn (token cũ không có `sid` → buộc đăng nhập lại).
- `services/session.service.js`: `startSession(user, req)` (tạo Session + ký JWT),
  `revokeUserSessions(userId, exceptId?)`, `parseDurationMs`. Login/register/verify-email đều
  qua `startSession`.
- Endpoints mới: `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`,
  `POST /api/auth/sessions/revoke-others`, `POST /api/auth/logout`.
- Đổi mật khẩu (`PATCH /users/me`) → revoke mọi thiết bị khác (giữ phiên hiện tại);
  reset-password & admin reset password → revoke tất cả.
- Frontend: card "Active sessions" trong `Profile.jsx` (liệt kê thiết bị, IP, last-active,
  nút đăng xuất từng máy + "sign out all other devices"); nút Sign out gọi `AuthApi.logout()`
  trước khi xoá state local.

### 3. Sửa các "residual" đã ghi trong memory — ✅ ĐÃ XONG
- Folder share có password: hiện list file **không** cần password, chỉ download mới chặn
  → nên gate cả việc list.
- `from-url` SSRF: `redirect: 'follow'` vẫn có thể nhảy sang host bị chặn → kiểm tra lại
  sau mỗi redirect.
- Bật CSP trong helmet (đang tắt).

**Đã triển khai:**
- Share có password giờ trả về `locked: true` không kèm nội dung; thêm
  `POST /api/shares/public/:token/unlock` để mở khoá sau khi nhập đúng mật khẩu
  (`shares.routes.js`). Frontend `Shared.jsx` hiện form Unlock trước khi lộ danh sách file.
- SSRF: `fetchFollowingSafely()` trong `files.routes.js` tự follow redirect thủ công và
  re-validate **mỗi hop** (`assertUrlAllowed`: chặn host nội bộ + DNS resolve về IP riêng),
  giới hạn 5 hop.
- CSP bật trong helmet (`app.js`) với directive an toàn cho Swagger UI; `upgrade-insecure-requests`
  tắt để dev HTTP vẫn chạy.

**Kiểm thử:** backend Vitest 8/8 pass, frontend Vitest 12/12 pass, `vite build` OK.

## 🚀 Tính năng mới giá trị cao

### 4. Office/PDF preview trong trình duyệt
Hiện chỉ preview ảnh/video/audio/text. Thêm PDF.js viewer + chuyển .docx/.xlsx/.pptx sang
PDF (LibreOffice headless — đã có sẵn base Debian để cài) để xem trực tiếp không cần tải.

### 5. Chỉnh sửa file cộng tác (collaborative)
Đã có presence WebSocket rồi. Mở rộng: comment realtime (thay vì poll), hoặc edit
text/markdown đồng thời (CRDT với Yjs). Tận dụng hạ tầng `/ws` sẵn có.

### 6. Trash tự động dọn (retention policy) — ✅ ĐÃ XONG
Cron job xoá cứng file ở trash sau N ngày. Hiện trash phải xoá thủ công → tốn quota MinIO
vĩnh viễn.

**Đã triển khai:**
- `services/retention.service.js`: `purgeExpiredTrash()` (xoá file/folder có `trashedAt` cũ hơn
  cutoff, xoá object MinIO + hoàn quota theo từng owner), `startRetentionJob()` (chạy lần đầu
  sau 60s, rồi mỗi 6h; `unref()` timers).
- Env `TRASH_RETENTION_DAYS` (mặc định 30; `0` = tắt) trong `config/env.js`; gọi
  `startRetentionJob()` trong `server.js`.
- `GET /api/trash` trả thêm `retentionDays`; `pages/Trash.jsx` hiện banner "Items in trash are
  permanently deleted after N days".

### 7. Encryption at rest cho file nhạy cảm
Client-side hoặc server-side encryption với key per-user. Vì là personal cloud lưu file
riêng tư.

### 8. Mobile app / hoàn thiện PWA — ✅ ĐÃ XONG
PWA đã có. Thêm: upload từ camera, share target (chia sẻ file từ app khác vào),
background sync khi mất mạng.

**Đã triển khai:**
- **Camera upload**: input `accept="image/*" capture="environment"` + method `capture()` trên
  `Uploader` ref; nút "Take photo" trong `Files.jsx` (mở thẳng camera sau trên mobile).
- **Share target**: `manifest.webmanifest` thêm `share_target` (POST multipart) + `shortcuts`;
  `sw.js` chặn `POST /share-target`, lưu file vào Cache Storage rồi redirect `/files?share-target=N`;
  `lib/shareTarget.js` đọc lại file từ cache → `uploaderRef.add(files)`. (Cache `share-target`
  được giữ qua `activate`; SW cache bump `v3`.)
- **Background sync (offline outbox)**: `lib/outbox.js` (IndexedDB lưu File). Khi offline,
  `Uploader.addFiles` xếp hàng vào outbox; tự upload lại khi có mạng (`online` event + lúc mount).
  Để ở page-level vì upload cần JWT (SW không đọc được localStorage). Banner "Offline" trong
  `Layout.jsx`.

## 🎯 AI nâng cao (đã có nền OCR + embeddings)

### 9. Hỏi-đáp tài liệu (RAG)
Đã có `embedding` per file rồi → thêm chat "hỏi về tài liệu của tôi", trả lời kèm trích
dẫn file. Dùng Claude API.

### 10. Auto-tag & phân loại tự động
Dùng OCR text + embedding để gợi ý tag, tự nhóm vào collection, phát hiện loại tài liệu
(hoá đơn, CV, ảnh chụp màn hình...).

### 11. Tìm kiếm trong ảnh bằng nội dung (CLIP)
"tìm ảnh có con mèo" — embedding ảnh thay vì chỉ OCR text.

## 🛠️ Hạ tầng & vận hành

### 12. Backup tự động
Dump Postgres + mirror MinIO bucket định kỳ ra nơi khác (rclone). Hiện chưa có gì chống
mất dữ liệu.

### 13. Metrics & monitoring
Prometheus endpoint + Grafana (dung lượng, số upload, lỗi). Hiện chỉ có Pino log.

### 14. Email deliverability
Dứt khoát bỏ docker-mailserver, dùng SendGrid/Resend/Mailgun free tier để mail không vào
spam (vấn đề PTR/DDNS đã ghi trong memory).

### 15. Rate limit & quota nâng cao
Giới hạn băng thông download, giới hạn số share/key per user, chống abuse drop-box.

---

## Lộ trình gợi ý (ngắn)

**#1 (2FA) → #6 (auto-clean trash) → #4 (PDF/Office preview) → #9 (RAG chat)**

— vừa vá bảo mật, vừa thêm tính năng "wow".
