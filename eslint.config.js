import tseslint from 'typescript-eslint';
import base from './eslint.base.mjs';

export default tseslint.config(
  // Org base (vendored from nanohype library/config, drift-gated).
  ...base,
  // src/vendor/ holds byte-identical copies of @nanohype/runtime modules,
  // linted at their source of truth — local lint fixes there would be drift.
  { ignores: ['src/vendor/', 'tests/', 'vitest.config.ts'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
);
