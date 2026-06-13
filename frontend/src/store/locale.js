// Task5 #22 — interface language, persisted like the theme store. Setting it
// drives i18next + the <html lang> attribute. The persisted key is 'locale';
// lib/i18n.js reads it synchronously to choose the initial language at boot.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n, { SUPPORTED_LANGUAGES } from '../lib/i18n.js';

function apply(lng) {
  if (!SUPPORTED_LANGUAGES.includes(lng)) return;
  if (i18n.language !== lng) i18n.changeLanguage(lng);
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', lng);
}

export const useLocale = create(
  persist(
    (set) => ({
      language: i18n.language || 'en',
      setLanguage: (language) => {
        if (!SUPPORTED_LANGUAGES.includes(language)) return;
        apply(language);
        set({ language });
      },
    }),
    {
      name: 'locale',
      onRehydrateStorage: () => (state) => {
        if (state?.language) apply(state.language);
      },
    },
  ),
);
