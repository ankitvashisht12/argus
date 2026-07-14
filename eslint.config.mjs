// Flat ESLint config for the ARGUS monorepo (engine + vscode).
// @typescript-eslint recommended (non type-aware) over the TypeScript sources.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/media/**', // plain self-contained webview JS/CSS, not part of the TS project
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      '**/*.map',
      'landing-page/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Allow intentionally-unused args when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Test files exercise internals with fixtures/casts; keep them lint-covered
    // but tolerant of unused test imports and deliberate `any` casts.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
