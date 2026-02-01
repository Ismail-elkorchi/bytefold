import { fileURLToPath } from 'node:url';
import path from 'node:path';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import promise from 'eslint-plugin-promise';
import regexp from 'eslint-plugin-regexp';
import unicorn from 'eslint-plugin-unicorn';
import eslintComments from 'eslint-plugin-eslint-comments';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsconfigPath = path.join(__dirname, 'tsconfig.eslint.json');

const basePlugins = {
  promise,
  regexp,
  unicorn,
  'eslint-comments': eslintComments
};

const baseRules = {
  'no-async-promise-executor': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-debugger': 'error',
  'no-duplicate-imports': 'error',
  'no-empty': 'error',
  'no-fallthrough': 'error',
  'no-new': 'error',
  'no-unsafe-finally': 'error',
  'no-useless-catch': 'error',
  'promise/no-multiple-resolved': 'error',
  'promise/no-return-wrap': 'error',
  'regexp/no-dupe-characters-character-class': 'error',
  'regexp/no-empty-character-class': 'error',
  'regexp/no-invalid-regexp': 'error',
  'unicorn/no-instanceof-array': 'error',
  'eslint-comments/disable-enable-pair': 'error',
  'eslint-comments/no-unlimited-disable': 'error',
  'eslint-comments/no-unused-disable': 'error',
  'eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }]
};

export default [
  {
    ignores: ['dist/**', 'dist-test/**', 'node_modules/**', 'bench/results/**']
  },
  {
    files: ['eslint.config.js', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    plugins: basePlugins,
    rules: baseRules
  },
  {
    files: [
      'mod.ts',
      'archive/**/*.ts',
      'compress/**/*.ts',
      'zip/**/*.ts',
      'tar/**/*.ts',
      'deno/**/*.ts',
      'bun/**/*.ts'
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 'latest'
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    plugins: basePlugins,
    rules: baseRules
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: tsconfigPath,
        tsconfigRootDir: __dirname,
        sourceType: 'module',
        ecmaVersion: 'latest'
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    plugins: {
      ...basePlugins,
      '@typescript-eslint': tsPlugin
    },
    rules: {
      ...baseRules,
      'no-shadow': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: true,
          allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: 'test' }]
        }
      ],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error'
    }
  }
];
