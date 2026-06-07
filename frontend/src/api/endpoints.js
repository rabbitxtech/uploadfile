import { api } from './client.js';

export const AuthApi = {
  register: (data) => api.post('/auth/register', data).then((r) => r.data),
  login: (data) => api.post('/auth/login', data).then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  forgotPassword: (identifier) =>
    api.post('/auth/forgot-password', { identifier }).then((r) => r.data),
  resetPassword: (token, password) =>
    api.post('/auth/reset-password', { token, password }).then((r) => r.data),
  verifyEmail: (token) => api.post('/auth/verify-email', { token }).then((r) => r.data),
  resendVerification: (identifier) =>
    api.post('/auth/resend-verification', { identifier }).then((r) => r.data),
  // Session management (Task 2)
  sessions: () => api.get('/auth/sessions').then((r) => r.data),
  revokeSession: (id) => api.delete(`/auth/sessions/${id}`).then((r) => r.data),
  revokeOtherSessions: () => api.post('/auth/sessions/revoke-others').then((r) => r.data),
  logout: () => api.post('/auth/logout').then((r) => r.data),
};

export const KeyApi = {
  list: () => api.get('/keys').then((r) => r.data),
  create: (name) => api.post('/keys', { name }).then((r) => r.data),
  remove: (id) => api.delete(`/keys/${id}`).then((r) => r.data),
};

export const AuditApi = {
  list: ({ action, limit } = {}) =>
    api.get('/audit', { params: { ...(action ? { action } : {}), ...(limit ? { limit } : {}) } }).then((r) => r.data),
};

export const FolderApi = {
  list: (parentId, { ownerId } = {}) =>
    api
      .get('/folders', { params: { parentId: parentId ?? '', ...(ownerId ? { ownerId } : {}) } })
      .then((r) => r.data),
  tree: ({ ownerId } = {}) =>
    api.get('/folders/tree', { params: ownerId ? { ownerId } : {} }).then((r) => r.data),
  breadcrumb: (id, { ownerId } = {}) =>
    api
      .get(`/folders/${id}/breadcrumb`, { params: ownerId ? { ownerId } : {} })
      .then((r) => r.data),
  create: (data) => api.post('/folders', data).then((r) => r.data),
  update: (id, data) => api.patch(`/folders/${id}`, data).then((r) => r.data),
  remove: (id) => api.delete(`/folders/${id}`).then((r) => r.data),
};

export const FileApi = {
  get: (id) => api.get(`/files/${id}`).then((r) => r.data),
  update: (id, data) => api.patch(`/files/${id}`, data).then((r) => r.data),
  remove: (id) => api.delete(`/files/${id}`).then((r) => r.data),
  search: (q, tag) => api.get('/files/search', { params: { q, tag } }).then((r) => r.data),
  recent: () => api.get('/files/recent').then((r) => r.data),
  fromUrl: (url, folderId) =>
    api.post('/files/from-url', { url, folderId: folderId || undefined }).then((r) => r.data),
  duplicates: (ownerId) =>
    api.get('/files/duplicates', { params: ownerId ? { ownerId } : {} }).then((r) => r.data),
  bulkRename: (renames) => api.post('/files/bulk/rename', { renames }).then((r) => r.data),
  semanticSearch: (q) =>
    api.get('/files/semantic-search', { params: { q } }).then((r) => r.data),
  reindex: () => api.post('/files/reindex').then((r) => r.data),
  analytics: (ownerId) =>
    api.get('/files/analytics', { params: ownerId ? { ownerId } : {} }).then((r) => r.data),
  starred: () => api.get('/files/starred').then((r) => r.data),
  star: (id) => api.post(`/files/${id}/star`).then((r) => r.data),
  bulkTrash: (ids) => api.post('/files/bulk/trash', { ids }).then((r) => r.data),
  bulkMove: (ids, folderId) => api.post('/files/bulk/move', { ids, folderId }).then((r) => r.data),
  presignedUrl: (id, { inline = false } = {}) =>
    api.get(`/files/${id}/url`, { params: inline ? { inline: 1 } : {} }).then((r) => r.data),
  // Sets an HttpOnly stream cookie (scoped to this file's /stream path); the
  // credential is never put in the URL. withCredentials so the cookie is stored.
  streamToken: (id) => api.get(`/files/${id}/stream-token`, { withCredentials: true }).then((r) => r.data),
  getProgress: (id) => api.get(`/files/${id}/progress`).then((r) => r.data),
  saveProgress: (id, position, duration) =>
    api.put(`/files/${id}/progress`, { position, duration }).then((r) => r.data),
  clearProgress: (id) => api.delete(`/files/${id}/progress`).then((r) => r.data),
  versionUpload: (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return api
      .post(`/files/${id}/versions`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => r.data);
  },
};

export const NotificationApi = {
  list: ({ unread = false, limit = 50 } = {}) =>
    api.get('/notifications', { params: { unread: unread ? 1 : 0, limit } }).then((r) => r.data),
  markRead: (id) => api.post(`/notifications/${id}/read`).then((r) => r.data),
  markAllRead: () => api.post('/notifications/mark-all-read').then((r) => r.data),
  remove: (id) => api.delete(`/notifications/${id}`).then((r) => r.data),
  clear: () => api.post('/notifications/clear').then((r) => r.data),
};

export const GrantApi = {
  sharedWithMe: () => api.get('/grants/shared-with-me').then((r) => r.data),
  list: ({ fileId, folderId } = {}) =>
    api.get('/grants', { params: { ...(fileId ? { fileId } : {}), ...(folderId ? { folderId } : {}) } }).then((r) => r.data),
  create: (data) => api.post('/grants', data).then((r) => r.data),
  removeFile: (id) => api.delete(`/grants/file/${id}`).then((r) => r.data),
  removeFolder: (id) => api.delete(`/grants/folder/${id}`).then((r) => r.data),
};

export const CommentApi = {
  list: (fileId) => api.get(`/files/${fileId}/comments`).then((r) => r.data),
  add: (fileId, body) => api.post(`/files/${fileId}/comments`, { body }).then((r) => r.data),
  remove: (fileId, cid) => api.delete(`/files/${fileId}/comments/${cid}`).then((r) => r.data),
};

export const TrashApi = {
  list: ({ ownerId } = {}) =>
    api.get('/trash', { params: ownerId ? { ownerId } : {} }).then((r) => r.data),
  restore: (ids) => api.post('/trash/restore', ids).then((r) => r.data),
  empty: ({ ownerId } = {}) =>
    api.post('/trash/empty', null, { params: ownerId ? { ownerId } : {} }).then((r) => r.data),
  removeFile: (id) => api.delete(`/trash/file/${id}`).then((r) => r.data),
};

export const ShareApi = {
  list: () => api.get('/shares').then((r) => r.data),
  create: (data) => api.post('/shares', data).then((r) => r.data),
  remove: (id) => api.delete(`/shares/${id}`).then((r) => r.data),
  access: (id) => api.get(`/shares/${id}/access`).then((r) => r.data),
  public: (token) => api.get(`/shares/public/${token}`).then((r) => r.data),
  unlock: (token, password) =>
    api.post(`/shares/public/${token}/unlock`, { password }).then((r) => r.data),
  publicUpload: (token, file, password) => {
    const fd = new FormData();
    fd.append('file', file);
    if (password) fd.append('password', password);
    return api
      .post(`/shares/public/${token}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => r.data);
  },
};

export const CollectionApi = {
  list: () => api.get('/collections').then((r) => r.data),
  get: (id) => api.get(`/collections/${id}`).then((r) => r.data),
  create: (data) => api.post('/collections', data).then((r) => r.data),
  update: (id, data) => api.patch(`/collections/${id}`, data).then((r) => r.data),
  remove: (id) => api.delete(`/collections/${id}`).then((r) => r.data),
  addFiles: (id, fileIds) => api.post(`/collections/${id}/files`, { fileIds }).then((r) => r.data),
  removeFile: (id, fileId) => api.delete(`/collections/${id}/files/${fileId}`).then((r) => r.data),
};

export const UserApi = {
  updateMe: (data) => api.patch('/users/me', data).then((r) => r.data),
  list: () => api.get('/users').then((r) => r.data),
  create: (data) => api.post('/users', data).then((r) => r.data),
  update: (id, data) => api.patch(`/users/${id}`, data).then((r) => r.data),
  remove: (id) => api.delete(`/users/${id}`).then((r) => r.data),
};
