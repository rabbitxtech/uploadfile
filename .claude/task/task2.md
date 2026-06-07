A. Hoàn thiện feature đã có nửa vời (chi phí thấp, ROI cao)
1. [DONE] Tags UI — chip inline trên file row, popover edit (Enter/Backspace), filter sidebar khi click chip
2. [DONE] Folder share links — ShareModal nhận folderId; public folder view list files + ZIP download
3. [DONE] Drag-drop move — file row draggable; folder row + folder tree node là drop target
4. [DONE] Folder tree sidebar — `/api/folders/tree` + component thu/mở, active highlight, root drop target
B. Bảo mật / hardening (cần thiết trước khi prod) — [DONE]
5. [DONE] Rate limit — express-rate-limit; authLimiter (login/register/forgot/reset 20/15ph) + publicLimiter (/shares/public 100/15ph); app.set('trust proxy',1) để lấy IP thật sau nginx. Verified 429.
6. [DONE] Audit log — model AuditLog; service audit() best-effort; log login/login_failed/user_ban|unban|role|quota|delete|password/share_create|revoke/apikey/password_reset; trang admin /audit (lọc theo action). IP thật.
7. [DONE] Per-share download log — model ShareAccess; log view/download/upload trên route public; GET /shares/:id/access (chủ share) + summary; modal "Views" ở trang Shares.
8. [DONE] API key — model ApiKey (sha256 hash, prefix hiển thị); POST/GET/DELETE /api/keys; requireAuth nhận uk_ qua Authorization Bearer hoặc X-API-Key; UI quản lý trong Profile (hiện secret 1 lần). Verified auth.
9. [DONE] Reset password — model Token; POST /auth/forgot-password (không lộ tồn tại account) + /auth/reset-password (token sha256, hết hạn 1h, dùng 1 lần); mail.service nodemailer SMTP-optional (chưa có SMTP thì log link); trang ForgotPassword + ResetPassword + link ở Login. (Email-verify cột emailVerified có sẵn nhưng không ép buộc vì login bằng username.) Verified full flow.
C. Quality of life UI
10. [DONE] Dark mode toggle — store/theme.js + Tailwind darkMode:'class' + dark: variants
11. [DONE] Mobile responsive — sidebar drawer < md, top bar với hamburger + theme toggle
12. [DONE] Grid view cho ảnh — toggle list/grid, gợi ý tự động khi >= 50% là ảnh
13. [DONE] Recent + Starred view — File.starred + File.accessedAt; bump on preview/download/url; nav + page + star toggle
14. [DONE] Notification center — Notification table + polling 30s; trigger từ public download / admin role+quota+ban / welcome on register & create user
D. Devops / chất lượng code
15. [DONE] Tests — Vitest + Supertest backend (access/video/app+openapi = 8 tests); Vitest + RTL frontend (format + FolderTree = 7 tests). `npm test` hai bên.
16. [DONE] OpenAPI/Swagger — src/openapi.js (curated OpenAPI 3) phục vụ qua swagger-ui-express tại /api/docs + /api/openapi.json.
17. [DONE] Prisma migrations — baseline 0_init (prisma migrate diff), resolve --applied trên DB hiện tại, Dockerfile chuyển sang `migrate deploy`.
18. [DONE] Structured logging — Pino + pino-http thay morgan; redact authorization/cookie; logger.js có pretty (dev) / JSON (prod).
19. [DONE] GitHub Actions CI — .github/workflows/ci.yml: backend (install + prisma generate + test), frontend (install + lint + test + build).
E. Multi-user collaboration
20. [DONE] Share với user khác — FileGrant/FolderGrant { fileId|folderId, userId, permission view|edit }; ShareModal tab "With a user"; trang "Shared with me"; access.service.js centralize quyền đọc/sửa
21. [DONE] Comment trên file — Comment model; GET/POST/DELETE /files/:id/comments; panel trong PreviewModal; notify owner
22. [DONE] Per-folder permission — FolderGrant view/edit; kế thừa xuống file con qua path prefix; navigate vào shared folder + breadcrumb giới hạn ở granted root

F. Làm thêm ngoài list (theo yêu cầu phát sinh)
23. [DONE] Login bằng username thường (không bắt buộc email) — regex /^[a-zA-Z0-9._-]+$/ hoặc email, lưu chung cột User.email
24. [DONE] Admin xem file user khác (read-only) → mở rộng thành admin TOÀN QUYỀN: xóa/sửa/move/share/star/bulk mọi file & folder; quota tính đúng owner
25. [DONE] Admin xem + empty/restore/hard-delete trash của user khác (?ownerId), quota hoàn về owner thật
26. [DONE] Video player tự chế — seek-on-release, rAF (no re-render), speed/loop/PiP/screenshot/fullscreen, phím tắt; fullscreen auto-hide control bar; thumb tua rõ
27. [DONE] Faststart remux video on upload (ffmpeg -c copy -movflags +faststart, non-destructive) + endpoint /optimize
28. [DONE] Up-next autoplay — đếm ngược 10s chuyển video kế trong cùng folder
29. [DONE] Tiếp tục xem (resume) — WatchProgress { userId, fileId, position, duration }; đồng bộ qua thiết bị; GET/PUT/DELETE /files/:id/progress; banner "Resumed from"
30. [DONE] Comment panel đẹp (avatar màu, bong bóng, time-ago); dark mode tinh chỉnh palette + contrast

=== TRẠNG THÁI ===
Hoàn thành: A (1-4), B (5-9), C (10-14), D (15-19), E (20-22), F (23-30). TẤT CẢ XONG.
Email (B9): DEV dùng Mailpit (đã wire trong docker-compose.yml, SMTP_HOST=mailpit:1025, web UI :8025) — đã verify gửi+nhận+reset round-trip. PROD dùng docker-mailserver qua docker-compose.prod.yml (override, gate mailpit bằng profile dev-only) + mailserver.env(.example) + docs/mail-setup.md (tạo account, DNS SPF/DKIM/DMARC/PTR). mail.service skip recipient không phải email + log lỗi gửi. Tài khoản username-only (vd "admin") không nhận được mail.
