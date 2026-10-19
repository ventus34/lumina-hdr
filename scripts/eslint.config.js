import eslint from '@eslint/js';
import globals from 'globals';

const recommendedRules = {
  ...eslint.configs.recommended.rules,
  'no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    varsIgnorePattern: '^_'
  }]
};

export default [
  { ignores: ['dist/**', 'docs/**', 'node_modules/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webworker }
    },
    rules: recommendedRules
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    rules: recommendedRules
  },
  {
    files: ['vite.config.js', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: recommendedRules
  }
];
