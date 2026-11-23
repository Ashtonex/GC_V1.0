import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dev-dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['**/*.{js,mjs,cjs}', '**/*.config.ts', 'apps/web/scripts/**', 'apps/web/e2e/**'],
    languageOptions: { globals: globals.node },
  },
  {
    // Section 2 #4: money is never a float. parseFloat on money paths is banned in the engine and schema.
    files: ['packages/engine/src/**/*.ts', 'packages/schema/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Money is never a float (Section 2 #4).' }],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'Money is never a float (Section 2 #4).' },
        { object: 'Math', property: 'round', message: 'Use integer minor units or a decimal library (Section 2 #4).' },
      ],
    },
  },
);
