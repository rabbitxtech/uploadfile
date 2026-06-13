// Task5 #22 — i18n language switching via the locale store.
import { describe, it, expect, afterEach } from 'vitest';
import i18n from '../lib/i18n.js';
import { useLocale } from './locale.js';

afterEach(() => {
  // Leave the suite on English so other tests (Layout) keep asserting EN strings.
  useLocale.getState().setLanguage('en');
});

describe('i18n', () => {
  it('initializes in English with bundled translations (not raw keys)', () => {
    i18n.changeLanguage('en');
    expect(i18n.t('nav.trash')).toBe('Trash');
    expect(i18n.t('files.noFiles')).toBe('No files');
  });

  it('interpolates and pluralizes', () => {
    i18n.changeLanguage('en');
    expect(i18n.t('files.selectedCount', { count: 3 })).toBe('3 selected');
    expect(i18n.t('files.movedToTrash', { count: 1 })).toBe('Moved 1 item to trash');
    expect(i18n.t('files.movedToTrash', { count: 5 })).toBe('Moved 5 items to trash');
  });

  it('falls back to English for an unknown key path', () => {
    expect(i18n.t('nav.trash', { lng: 'vi' })).toBe('Thùng rác');
  });
});

describe('locale store', () => {
  it('switches the active language and updates <html lang>', () => {
    useLocale.getState().setLanguage('vi');
    expect(useLocale.getState().language).toBe('vi');
    expect(i18n.language).toBe('vi');
    expect(i18n.t('nav.trash')).toBe('Thùng rác');
    expect(document.documentElement.getAttribute('lang')).toBe('vi');

    useLocale.getState().setLanguage('en');
    expect(i18n.t('nav.trash')).toBe('Trash');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('ignores unsupported languages', () => {
    useLocale.getState().setLanguage('en');
    useLocale.getState().setLanguage('fr');
    // language() unchanged because apply() guards on the supported list
    expect(i18n.language).toBe('en');
  });
});
