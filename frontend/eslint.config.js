import js from '@eslint/js';
import globals from 'globals';
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
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // eslint-plugin-react is not installed, so ESLint cannot see that a
      // capitalised binding is used as a JSX element (`<Icon />`). Both the
      // vars and the args patterns therefore exempt PascalCase — otherwise
      // every `({ icon: Icon })` component prop is a false positive, and the
      // "fix" would be renaming a variable that is genuinely used.
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^(_|[A-Z])',
          varsIgnorePattern: '^[A-Z_]',
          caughtErrors: 'none',
        },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
