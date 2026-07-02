import tseslint from 'typescript-eslint';
import base from '../../eslint.base.mjs';

export default tseslint.config(
  // Org base (vendored at the repo root from nanohype library/config).
  ...base,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
