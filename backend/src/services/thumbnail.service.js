import sharp from 'sharp';
import { getObjectStream, putObjectBuffer } from './storage.service.js';

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
]);

export function canThumbnail(mimeType) {
  return IMAGE_TYPES.has(mimeType);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function generateThumbnail(sourceKey, mimeType) {
  if (!canThumbnail(mimeType)) return null;
  const stream = await getObjectStream(sourceKey);
  const input = await streamToBuffer(stream);
  const thumb = await sharp(input)
    .rotate()
    .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const thumbKey = sourceKey.replace(/^u\//, 't/') + '.webp';
  await putObjectBuffer(thumbKey, thumb, 'image/webp');
  return thumbKey;
}
