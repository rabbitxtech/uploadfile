import { describe, it, expect } from 'vitest';
import { formatBytes, fileIcon } from './format.js';

describe('formatBytes', () => {
  it('formats byte sizes with units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
  });

  it('accepts BigInt-style strings', () => {
    expect(formatBytes('2048')).toBe('2.0 KB');
  });

  it('returns dash for non-numbers', () => {
    expect(formatBytes('abc')).toBe('-');
  });
});

describe('fileIcon', () => {
  it('maps mime types to icon keys', () => {
    expect(fileIcon('image/png')).toBe('image');
    expect(fileIcon('video/mp4')).toBe('video');
    expect(fileIcon('audio/mp3')).toBe('audio');
    expect(fileIcon('application/pdf')).toBe('pdf');
    expect(fileIcon('application/zip')).toBe('archive');
    expect(fileIcon('text/plain')).toBe('file');
    expect(fileIcon(null)).toBe('file');
  });
});
