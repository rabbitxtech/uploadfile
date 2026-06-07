import { describe, it, expect } from 'vitest';
import { canFaststart } from '../src/services/video.service.js';

describe('video.service · canFaststart', () => {
  it('accepts common MP4/MOV video types', () => {
    expect(canFaststart('video/mp4')).toBe(true);
    expect(canFaststart('video/quicktime')).toBe(true);
    expect(canFaststart('video/x-m4v')).toBe(true);
  });

  it('rejects non-remuxable types', () => {
    expect(canFaststart('video/webm')).toBe(false);
    expect(canFaststart('image/png')).toBe(false);
    expect(canFaststart('')).toBe(false);
  });
});
