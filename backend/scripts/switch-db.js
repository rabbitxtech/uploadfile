#!/usr/bin/env node
// Usage: npm run db:switch postgresql | mysql | sqlite
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const allowed = ['postgresql', 'mysql', 'sqlite'];
const target = process.argv[2];

if (!allowed.includes(target)) {
  console.error(`Provider must be one of: ${allowed.join(', ')}`);
  process.exit(1);
}

const schemaPath = resolve(process.cwd(), 'prisma/schema.prisma');
const src = readFileSync(schemaPath, 'utf8');
let next = src.replace(/provider\s*=\s*"(postgresql|mysql|sqlite)"/, `provider = "${target}"`);

// Lines tagged `///pg-only` (e.g. the pgvector Unsupported("vector(384)")
// column, Task5 #12) are valid only on PostgreSQL — comment them out when
// switching to mysql/sqlite, uncomment when switching back.
next = next
  .split('\n')
  .map((line) => {
    if (!line.includes('///pg-only')) return line;
    if (target === 'postgresql') return line.replace(/^(\s*)\/\/ (?=\S)/, '$1');
    if (/^\s*\/\/ /.test(line)) return line; // already commented out
    return line.replace(/^(\s*)(?=\S)/, '$1// ');
  })
  .join('\n');

if (src === next) {
  console.log(`schema.prisma already uses ${target}`);
} else {
  writeFileSync(schemaPath, next);
  console.log(`schema.prisma provider -> ${target}`);
  console.log(`Now update DATABASE_URL in .env and run: npx prisma migrate dev --name init`);
}
