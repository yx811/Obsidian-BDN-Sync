/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    browser: true,
    es2020: true,
  },
  ignorePatterns: [
    'node_modules/**',
    'lib/**',
    'main.js',
    'styles.css',
    'styles.css.bak',
    '*.mjs',
    'esbuild.config.mjs',
  ],
  rules: {
    // 类型与显式注解
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/no-empty-interface': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-shadow': 'warn',
    // 通用整洁
    'prefer-const': 'error',
    'no-var': 'error',
    'no-duplicate-imports': 'error',
    'eqeqeq': ['warn', 'smart'],
    'no-debugger': 'error',
    'no-console': 'off', // 允许 engineLog 内的受控 console 调用
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
