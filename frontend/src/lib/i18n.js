// Task5 #22 — i18n (English + Vietnamese). Initialized synchronously with
// bundled resources so the first paint (and tests/SSR) get real strings, never
// raw keys. The persisted choice lives under the zustand 'locale' store; we read
// it here directly to pick the initial language before React mounts.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import vi from '../locales/vi.json';

export const SUPPORTED_LANGUAGES = ['en', 'vi'];

// Read the persisted language without importing the store (avoids a cycle).
function detectInitialLanguage() {
  try {
    const raw = localStorage.getItem('locale');
    if (raw) {
      const lng = JSON.parse(raw)?.state?.language;
      if (SUPPORTED_LANGUAGES.includes(lng)) return lng;
    }
  } catch {
    /* ignore malformed storage */
  }
  // First visit: follow the browser, default to English otherwise.
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

const initialLng = detectInitialLanguage();

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, vi: { translation: vi } },
    lng: initialLng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false }, // React already escapes
    returnEmptyString: false,
  });
}

// Keep <html lang> in sync for a11y / browser features.
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('lang', initialLng);
}

export default i18n;
