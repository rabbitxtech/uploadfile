# task3 — Ý tưởng tính năng (backlog)

Ghi chú: ưu tiên trong mỗi nhóm xếp theo ROI/chi phí — mục đầu thường tận dụng hạ tầng sẵn có (rẻ).
Trạng thái: [ ] chưa làm · [WIP] đang làm · [DONE] xong.
Bảo mật/hardening (nhóm B trong task2) làm sau cùng.

## G. Media & preview (mạnh nhất — đã có video player + ffmpeg + sharp)
- [DONE] G1. Video poster/thumbnail — generateVideoThumbnail (ffmpeg seek ~10% → sharp webp 480px → t/...webp, hasPreview); auto on upload (chunked + single-shot) + backfill qua /optimize; grid có play-icon overlay cho video.
- [DONE] G2. Subtitle — match file .srt/.vtt cùng folder theo tên (không cần schema); SRT→VTT client-side, blob URL `<track>`; nút CC trong player chọn Off/đổi phụ đề. (+ thêm .dockerignore fix build context node_modules)
- [DONE] G3. Audio player tự chế — AudioPlayer.jsx (pointer seek-on-release, rAF, speed 0.5–2x, volume, loop, skip ±10s, resume server-side WatchProgress); PreviewModal dùng cho audio + up-next autoplay (next audio cùng folder, dùng chung countdown với video).
- [DONE] G4. Image lightbox — ImageLightbox.jsx: zoom (wheel/nút/phím +-, clamp 1–8x), xoay 90°, pan kéo khi zoom, double-click zoom, **fullscreen thật** (Fullscreen API, nút + phím f, Esc thoát), reset/fit, prev/next ảnh (nút + phím ←→), panel EXIF (exifr same-origin). FIX: pan chỉ bám vào <img> nên nút toolbar (zoom-out…) hoạt động cả khi đang zoom (trước bị stage setPointerCapture nuốt click).
- [BỎ] G5. PDF viewer (pdf.js) — đã gỡ theo yêu cầu (react-pdf/pdfjs-dist ~1.4MB bundle). PDF quay lại dùng iframe. Xoá PdfViewer.jsx + deps.
- [DONE] G6. Markdown / code preview — TextPreview.jsx: .md render bằng marked + DOMPurify (style .md-body trong @layer), code syntax-highlight bằng highlight.js (atom-one-dark, map ~40 ext). isTextual() nhận cả application/json|javascript|xml + ext code dù mime không phải text/.

## H. Tổ chức & năng suất
- [DONE] H1. Storage analytics — GET /api/files/analytics (aggregate: totals, byCategory mime, byFolder top10, largest top10; admin ?ownerId); trang /stats (Layout nav "Storage") với summary cards, bar theo loại/folder, bảng file lớn nhất.
- [DONE] H2. Phát hiện trùng lặp — checksum.service.js (sha256): điền checksum khi upload (single-shot + from-url buffer; chunked stream-hash sau complete; public upload). GET /api/files/duplicates gom nhóm cùng checksum (count>1, wastedBytes). Trang /duplicates + nav "Duplicates": nhóm, đánh dấu bản cũ nhất "keep", nút trash bản thừa.
- [DONE] H3. Sort + nhớ lựa chọn — sort name/type/size/modified, dropdown + header bấm đảo chiều; nhớ theo từng folder qua localStorage (`filesort:<id>`). Áp cho cả list + grid + siblings PreviewModal.
- [DONE] H4. Bulk rename theo mẫu — BulkRenameModal: prefix/suffix, find&replace, đánh số tuần tự (pattern `IMG_###`, start, pad) + preview old→new trực tiếp; endpoint POST /api/files/bulk/rename (id→name pairs, validate ownership). Nút "Rename" trong bulk bar.
- [DONE] H5. Collections / saved search — model Collection (migration 20260606140000, m2m _CollectionFiles) kind manual|smart; routes CRUD + add/remove files + get (manual = file set, smart = chạy filter q/tag live). Trang /collections (tạo manual/smart) + /collections/:id (grid thumbnail, remove khỏi manual). AddToCollectionModal + nút "Add to collection" trong bulk bar.

## I. Sharing & collaboration (đã có grants + comments)
- [DONE] I1. Request files (upload link) — Share.allowUpload (migration 20260606120000); POST /shares/public/:token/upload (multer, no-auth, charge owner quota + checksum + thumbnail, notify owner; SSRF/ratelimit thuộc nhóm B). ShareModal: toggle "Allow uploads" cho folder share. Shared.jsx: dropzone upload ẩn danh khi allowUpload.
- [DONE~] I2. Share analytics — nền tảng đã có từ B7 (ShareAccess log view/download/upload + GET /shares/:id/access + modal "Views" với summary). Biểu đồ chi tiết hơn có thể thêm sau nếu cần.
- [DONE] I3. @mention trong comment — backend parse @username (regex) khi tạo comment → notify (type 'mention', loại trừ self+owner, dedup). Frontend highlight @mention trong body comment (renderMentions).
- [DONE] I4. Real-time presence — WebSocket `/ws` (ws lib, attach vào http server ở server.js, verify JWT qua query token, room theo fileId, broadcast danh sách viewer dedupe theo user, heartbeat ping/pong). Frontend lib/presence.js (1 WS dùng chung, ref-count room, auto-reconnect + rejoin) + usePresence(fileId). PreviewModal hiện avatar người khác đang xem + chấm xanh nhấp nháy. nginx proxy upgrade /ws. Test: 2 user cùng room → thấy nhau; nginx upgrade 101.

## J. Truy cập & sync
- [DONE] J1. PWA — manifest.webmanifest (standalone, theme-color, icon 192/512 + maskable, sinh bằng sharp), sw.js (network-first navigations + offline shell, cache-first asset hashed, bypass /api + presigned + non-GET), đăng ký SW ở main.jsx (PROD), index.html link manifest/apple-touch, nginx vá mime manifest + no-cache sw.js.
- [DONE] J2. Upload từ URL — POST /api/files/from-url (fetch server-side, stream cap 500MB, 2x quota check, tên từ URL/Content-Type, thumbnail+faststart như upload thường; SSRF guard cơ bản: chặn loopback/private/link-local + chỉ http(s)). UI: nút "From URL" ở Files (promptDialog + toast.promise).
- [DONE] J3. WebDAV endpoint — /webdav (webdav.routes.js, mount TRƯỚC cors để OPTIONS giữ header DAV). Basic auth (username+password account). Methods: OPTIONS(DAV:1,2)/PROPFIND(207 depth 0,1)/GET/HEAD/PUT(quota+checksum, overwrite)/MKCOL/DELETE(trash, cascade file)/MOVE(rename+move, rewrite path con)/LOCK-UNLOCK(faked)/PROPPATCH. nginx proxy /webdav. Profile có card hướng dẫn kết nối. Đã test E2E: PUT/PROPFIND/GET/MKCOL/MOVE/DELETE đều OK.
- [DONE] J4. CLI / API key — xong qua task2 B8 (ApiKey model, /api/keys, requireAuth nhận uk_ qua Bearer/X-API-Key). Script dùng key này gọi mọi endpoint /api thay JWT.

## K. AI / thông minh (tốn hơn, cần model)
   Hạ tầng: đổi backend base image alpine→**node:20-bookworm-slim** (glibc) để onnxruntime chạy; apt cài tesseract(eng+vie)+ffmpeg+poppler; thêm dep @xenova/transformers; volume models-cache:/app/models (TRANSFORMERS_CACHE).
- [DONE] K1. OCR ảnh/PDF → ai.service.ocrFromStorage (tesseract eng+vie cho ảnh; pdftoppm→OCR cho PDF, ≤8 trang). Lưu File.ocrText; chạy nền qua indexFile() ở mọi đường upload. /files/search mở rộng OR khớp name||ocrText. (Test: search "PURPLE" chỉ có trong OCR → ra file ✓)
- [ ] K2. Auto-tag ảnh — vision model gắn tag tự động.
- [ ] K3. Auto-transcribe video/audio → tạo phụ đề (whisper).
- [DONE] K4. Semantic search — embedding Xenova/all-MiniLM-L6-v2 (384 chiều) qua transformers.js; embed(name+ocrText) lưu File.embedding (JSON), cosine rank. GET /files/semantic-search (embed query → cosine, top 30, ngưỡng 0.2). POST /files/reindex (index file cũ, nền). FE: toggle "Semantic" ở ô search Files + card "AI search index" (nút reindex) ở Stats. (Test: cat↔kitten=0.746, cat↔finance=0.031 ✓; ảnh hoá đơn match "animal billing document" ✓)

## M. UX polish (nhanh, cảm nhận rõ)
- [DONE] M1. Command palette (Cmd/Ctrl+K) — CommandPalette.jsx (portal): tìm file (search ≥2 ký tự) + actions điều hướng (My files/Recent/Starred/Collections/Storage/Duplicates/Trash…) + toggle theme; bàn phím ↑↓/Enter/Esc. Global listener + nút "Quick search" ở sidebar.
- [DONE] M2. Multi-select shift-click + Undo toast — shift-click chọn dải (orderedRef + lastIdxRef theo thứ tự đã sort), bulkTrash hiện toast Undo (6s) gọi TrashApi.restore({fileIds,folderIds}).
- [DONE] M3. Inline rename — double-click tên (timer phân biệt single=open/preview vs double=rename) → input tại chỗ (Enter lưu/Esc huỷ/blur lưu); nút Rename cũng mở inline. EditableName trong FileRow.jsx, submitRenameFile/Folder ở Files.jsx.
- [DONE] M4. Breadcrumb dropdown — CrumbDropdown: caret sau Home + mỗi crumb, mở list folder con (query khi mở) để nhảy ngang nhánh.

---
Batch gợi ý làm trước (rủi ro thấp, dựa trên hạ tầng sẵn có):
G1 (video thumbnail) + G2 (subtitle) + G3 (audio player) + H1 (storage analytics) + J2 (upload từ URL) + J1 (PWA).
→ ĐÃ XONG TOÀN BỘ BATCH (2026-06-06). Còn lại: nhóm B (bảo mật/hardening) làm sau cùng theo yêu cầu; các nhóm G4–G6/H2–H5/I/K/M là backlog tuỳ chọn.

Ghi chú hạ tầng quan trọng phát hiện khi làm batch:
- Đã thêm frontend/.dockerignore + backend/.dockerignore (loại node_modules). Trước đó node_modules host (sinh ra khi chạy test cục bộ) lọt vào build context, symlink hỏng (.bin/acorn) làm COPY thất bại âm thầm → Docker giữ image cũ (bundle stale). Đây là nguyên nhân các lần build "không đổi" trước đó; nay build cache thường đã hoạt động, không cần --no-cache.
