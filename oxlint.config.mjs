import { defineConfig } from 'oxlint'
import { configs } from 'ai-deslop'

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc'],
  jsPlugins: ['ai-deslop'],
  options: configs.recommended.options,
  rules: {
    ...configs.recommended.rules,
    'deslop/no-duplicate-types': 'error',
    'deslop/no-reexports-outside-entrypoints': 'error',
    'deslop/no-renamed-imports': 'error',
  },
  categories: {
    correctness: 'error',
  },
  env: {
    node: true,
  },
  globals: {
    Bun: 'readonly',
  },
  ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/.argrail/**', '**/*.gen.ts'],
})
