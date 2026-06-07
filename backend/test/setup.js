// Provide the env vars that config modules require, so importing them during
// tests doesn't throw. These are dummy values — tests here don't hit a real DB
// or MinIO.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
process.env.MINIO_PORT = process.env.MINIO_PORT || '9000';
process.env.MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'test';
process.env.MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'test';
process.env.MINIO_BUCKET = process.env.MINIO_BUCKET || 'uploads';
process.env.MINIO_PUBLIC_ENDPOINT = process.env.MINIO_PUBLIC_ENDPOINT || 'http://localhost:9000';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
