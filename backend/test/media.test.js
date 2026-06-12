import { describe, it, expect } from 'vitest';
import { canHls, hlsPrefix } from '../src/services/hls.service.js';
import { canTranscribe, vttToText } from '../src/services/transcribe.service.js';

describe('hls.service', () => {
  it('accepts common video types and rejects others', () => {
    expect(canHls('video/mp4')).toBe(true);
    expect(canHls('video/x-matroska')).toBe(true);
    expect(canHls('audio/mpeg')).toBe(false);
    expect(canHls('image/png')).toBe(false);
  });

  it('namespaces renditions under h/<fileId>/', () => {
    expect(hlsPrefix('abc')).toBe('h/abc/');
  });
});

describe('transcribe.service', () => {
  it('canTranscribe matches video and audio mimes only', () => {
    expect(canTranscribe('video/mp4')).toBe(true);
    expect(canTranscribe('audio/mpeg')).toBe(true);
    expect(canTranscribe('application/pdf')).toBe(false);
    expect(canTranscribe('')).toBe(false);
  });

  it('vttToText strips headers, timestamps and tags', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:02.500',
      'Hello <i>world</i>',
      '',
      'NOTE internal',
      '2',
      '00:00:02.500 --> 00:00:04.000',
      'Xin chào',
    ].join('\n');
    expect(vttToText(vtt)).toBe('Hello world\nXin chào');
  });
});
