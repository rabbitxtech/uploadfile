import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// Lenient config — surfaces real problems (react-hooks rules, obvious errors)
// without drowning the existing codebase in style noise.
export default [
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The reason eslint-plugin-react is here at all: jsx-uses-vars marks a
      // binding as used when it appears as a JSX element. Without it every
      // `({ icon: Icon })` component prop reads as an unused variable, and the
      // tempting "fix" is renaming something that is genuinely used.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      // Real bugs, not style: a key-less list silently breaks reconciliation,
      // and a mutated prop or a state write during render is a defect.
      'react/jsx-key': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/no-children-prop': 'error',
      // Deliberately NOT enabled: prop-types (this codebase does not use them)
      // and react-in-jsx-scope (the automatic JSX runtime makes it obsolete).
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
