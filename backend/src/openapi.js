// Curated OpenAPI 3 description of the public API surface. Served at /api/docs
// (Swagger UI) and /api/openapi.json. Kept hand-maintained for clarity; update
// it when routes change.

const bearer = [{ bearerAuth: [] }];

function jsonBody(properties, required = []) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { type: 'object', properties, required },
      },
    },
  };
}

const ok = { description: 'Success' };

export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Uploader API',
    version: '1.0.0',
    description:
      'File upload & management API. JWT bearer auth; the first registered user becomes admin.',
  },
  servers: [{ url: '/', description: 'This server' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string', description: 'Username or email' },
          name: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['admin', 'user'] },
          banned: { type: 'boolean' },
          quotaBytes: { type: 'string' },
          usedBytes: { type: 'string' },
        },
      },
      File: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          mimeType: { type: 'string' },
          size: { type: 'string', description: 'BigInt serialized as string' },
          folderId: { type: 'string', nullable: true },
          starred: { type: 'boolean' },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  tags: [
    { name: 'Auth' },
    { name: 'Files' },
    { name: 'Folders' },
    { name: 'Upload' },
    { name: 'Shares' },
    { name: 'Trash' },
    { name: 'Users' },
    { name: 'Notifications' },
    { name: 'Grants' },
  ],
  paths: {
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register (first user becomes admin)',
        requestBody: jsonBody(
          {
            email: { type: 'string', description: 'Username or email' },
            password: { type: 'string', minLength: 6 },
            name: { type: 'string' },
          },
          ['email', 'password'],
        ),
        responses: { 201: ok, 400: { description: 'Validation error' } },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in',
        requestBody: jsonBody({ email: { type: 'string' }, password: { type: 'string' } }, [
          'email',
          'password',
        ]),
        responses: { 200: ok, 401: { description: 'Invalid credentials' } },
      },
    },
    '/api/auth/2fa/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Complete a 2FA login (tmpToken from /login + TOTP or recovery code)',
        requestBody: jsonBody({ tmpToken: { type: 'string' }, code: { type: 'string' } }, ['tmpToken', 'code']),
        responses: { 200: ok, 401: { description: 'Invalid code or expired login' } },
      },
    },
    '/api/auth/2fa/setup': {
      post: { tags: ['Auth'], summary: 'Begin TOTP setup (returns secret + QR)', security: bearer, responses: { 200: ok } },
    },
    '/api/auth/2fa/enable': {
      post: {
        tags: ['Auth'],
        summary: 'Confirm setup with a code — enables 2FA, returns one-time recovery codes',
        security: bearer,
        requestBody: jsonBody({ code: { type: 'string' } }, ['code']),
        responses: { 200: ok, 400: { description: 'Invalid code' } },
      },
    },
    '/api/auth/2fa/disable': {
      post: {
        tags: ['Auth'],
        summary: 'Disable 2FA (requires password + valid code)',
        security: bearer,
        requestBody: jsonBody({ password: { type: 'string' }, code: { type: 'string' } }, ['password', 'code']),
        responses: { 200: ok, 401: { description: 'Wrong password or code' } },
      },
    },
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Current user', security: bearer, responses: { 200: ok } },
    },
    '/api/folders': {
      get: {
        tags: ['Folders'],
        summary: 'List a folder (or root)',
        description:
          'Files are cursor-paginated. The first page also returns the folder list and `total`; follow `nextCursor` (null when exhausted) to fetch more files.',
        security: bearer,
        parameters: [
          { name: 'parentId', in: 'query', schema: { type: 'string' } },
          { name: 'ownerId', in: 'query', schema: { type: 'string' }, description: 'Admin only' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'File id from the previous page’s nextCursor' },
          { name: 'take', in: 'query', schema: { type: 'integer', default: 200, maximum: 500 } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'type', 'size', 'modified'], default: 'name' } },
          { name: 'dir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
        ],
        responses: { 200: ok },
      },
      post: {
        tags: ['Folders'],
        summary: 'Create a folder',
        security: bearer,
        requestBody: jsonBody({ name: { type: 'string' }, parentId: { type: 'string' } }, ['name']),
        responses: { 201: ok },
      },
    },
    '/api/folders/tree': {
      get: { tags: ['Folders'], summary: 'Flat folder tree', security: bearer, responses: { 200: ok } },
    },
    '/api/files': {
      post: {
        tags: ['Files'],
        summary: 'Single-shot upload (<= 100 MB)',
        security: bearer,
        requestBody: {
          content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, folderId: { type: 'string' } } } } },
        },
        responses: { 201: ok },
      },
    },
    '/api/files/search': {
      get: {
        tags: ['Files'],
        summary: 'Search by name / tag',
        security: bearer,
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: ok },
      },
    },
    '/api/files/recent': { get: { tags: ['Files'], summary: 'Recently accessed', security: bearer, responses: { 200: ok } } },
    '/api/files/starred': { get: { tags: ['Files'], summary: 'Starred files', security: bearer, responses: { 200: ok } } },
    '/api/files/analytics': { get: { tags: ['Files'], summary: 'Storage analytics (totals, by type, by folder, largest). Admin may pass ?ownerId', security: bearer, parameters: [{ name: 'ownerId', in: 'query', schema: { type: 'string' }, description: 'admin only' }], responses: { 200: ok } } },
    '/api/files/{id}': {
      get: { tags: ['Files'], summary: 'Get a file', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok, 404: { description: 'Not found' } } },
      patch: { tags: ['Files'], summary: 'Rename / move / tag', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
      delete: { tags: ['Files'], summary: 'Soft-delete (to trash)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/files/{id}/url': {
      get: { tags: ['Files'], summary: 'Presigned URL (?inline=1 for preview)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'inline', in: 'query', schema: { type: 'integer' } }], responses: { 200: ok } },
    },
    '/api/files/{id}/star': {
      post: { tags: ['Files'], summary: 'Toggle star', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/files/{id}/progress': {
      get: { tags: ['Files'], summary: 'Get watch progress', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
      put: { tags: ['Files'], summary: 'Save watch progress', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ position: { type: 'integer' }, duration: { type: 'integer' } }, ['position']), responses: { 200: ok } },
    },
    '/api/files/{id}/comments': {
      get: { tags: ['Files'], summary: 'List comments', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
      post: { tags: ['Files'], summary: 'Add a comment', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ body: { type: 'string' } }, ['body']), responses: { 201: ok } },
    },
    '/api/files/{id}/collab-save': {
      post: {
        tags: ['Files'],
        summary: 'Save collaborative editor text as a new FileVersion (edit access; Task5 #6)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: jsonBody({ text: { type: 'string' } }, ['text']),
        responses: { 200: ok, 403: { description: 'No edit access' } },
      },
    },
    '/api/upload/init': {
      post: { tags: ['Upload'], summary: 'Start a chunked upload', security: bearer, requestBody: jsonBody({ filename: { type: 'string' }, size: { type: 'integer' }, mimeType: { type: 'string' }, folderId: { type: 'string' }, replaceFileId: { type: 'string' } }, ['filename', 'size']), responses: { 201: ok } },
    },
    '/api/upload/{id}/part': {
      put: { tags: ['Upload'], summary: 'Upload one chunk (raw body)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'part', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: ok } },
    },
    '/api/upload/{id}/complete': {
      post: { tags: ['Upload'], summary: 'Finalize a chunked upload', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 201: ok } },
    },
    '/api/shares': {
      get: { tags: ['Shares'], summary: 'List my share links', security: bearer, responses: { 200: ok } },
      post: { tags: ['Shares'], summary: 'Create a public share link', security: bearer, requestBody: jsonBody({ fileId: { type: 'string' }, folderId: { type: 'string' }, label: { type: 'string' }, password: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, maxDownloads: { type: 'integer' } }), responses: { 201: ok } },
    },
    '/api/shares/{id}': {
      patch: { tags: ['Shares'], summary: 'Update share label / extend expiry', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ label: { type: 'string', nullable: true }, expiresAt: { type: 'string', format: 'date-time', nullable: true } }), responses: { 200: ok } },
      delete: { tags: ['Shares'], summary: 'Revoke a share link', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/shares/public/{token}': {
      get: { tags: ['Shares'], summary: 'Public share info (no auth)', parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok, 403: { description: 'Expired / limit reached' } } },
    },
    '/api/grants': {
      get: { tags: ['Grants'], summary: 'List grants on a file/folder', security: bearer, parameters: [{ name: 'fileId', in: 'query', schema: { type: 'string' } }, { name: 'folderId', in: 'query', schema: { type: 'string' } }], responses: { 200: ok } },
      post: { tags: ['Grants'], summary: 'Share a file/folder with a user or group', security: bearer, requestBody: jsonBody({ fileId: { type: 'string' }, folderId: { type: 'string' }, identifier: { type: 'string' }, groupId: { type: 'string' }, permission: { type: 'string', enum: ['view', 'edit'] } }), responses: { 201: ok } },
    },
    '/api/grants/shared-with-me': {
      get: { tags: ['Grants'], summary: 'Files/folders shared with me (directly or via group)', security: bearer, responses: { 200: ok } },
    },
    '/api/groups': {
      get: { tags: ['Groups'], summary: 'List groups (members included for admins)', security: bearer, responses: { 200: ok } },
      post: { tags: ['Groups'], summary: 'Create a group (admin)', security: bearer, requestBody: jsonBody({ name: { type: 'string' } }, ['name']), responses: { 201: ok } },
    },
    '/api/groups/{id}': {
      patch: { tags: ['Groups'], summary: 'Rename a group (admin)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ name: { type: 'string' } }, ['name']), responses: { 200: ok } },
      delete: { tags: ['Groups'], summary: 'Delete a group (admin)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/groups/{id}/members': {
      post: { tags: ['Groups'], summary: 'Add a member by username/email (admin)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ identifier: { type: 'string' } }, ['identifier']), responses: { 201: ok } },
    },
    '/api/groups/{id}/members/{userId}': {
      delete: { tags: ['Groups'], summary: 'Remove a member (admin)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'userId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/trash': {
      get: { tags: ['Trash'], summary: 'List trashed items (admin ?ownerId=)', security: bearer, parameters: [{ name: 'ownerId', in: 'query', schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/trash/empty': {
      post: { tags: ['Trash'], summary: 'Empty trash (admin ?ownerId=)', security: bearer, parameters: [{ name: 'ownerId', in: 'query', schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/users': {
      get: { tags: ['Users'], summary: 'List users (admin)', security: bearer, responses: { 200: ok } },
      post: { tags: ['Users'], summary: 'Create a user (admin)', security: bearer, requestBody: jsonBody({ email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, quotaBytes: { type: 'string' } }, ['email', 'password']), responses: { 201: ok } },
    },
    '/api/users/{id}': {
      patch: { tags: ['Users'], summary: 'Update a user (admin: role/quota/ban/password)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
      delete: { tags: ['Users'], summary: 'Delete a user (admin)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } },
    },
    '/api/notifications': {
      get: { tags: ['Notifications'], summary: 'List notifications', security: bearer, parameters: [{ name: 'unread', in: 'query', schema: { type: 'integer' } }], responses: { 200: ok } },
    },
    '/api/push/vapid-public-key': {
      get: { tags: ['Push'], summary: 'VAPID public key + whether push is configured', responses: { 200: ok } },
    },
    '/api/push/subscribe': {
      post: {
        tags: ['Push'],
        summary: 'Register this browser for Web Push',
        security: bearer,
        requestBody: jsonBody({ subscription: { type: 'object', description: 'PushSubscription.toJSON()' } }, ['subscription']),
        responses: { 201: ok },
      },
    },
    '/api/push/unsubscribe': {
      post: {
        tags: ['Push'],
        summary: 'Remove this browser from Web Push',
        security: bearer,
        requestBody: jsonBody({ endpoint: { type: 'string' } }, ['endpoint']),
        responses: { 200: ok },
      },
    },
  },
};
