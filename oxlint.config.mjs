import { defineConfig } from 'oxlint'
import { configs as deslopConfigs } from 'ai-deslop'

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc'],
  jsPlugins: ['ai-deslop'],
  options: deslopConfigs.recommended.options,
  rules: {
    ...deslopConfigs.recommended.rules,
    // Temporarily skipped at the user's request.
    'deslop/require-safety-comment-for-type-assertion': 'off',
    'deslop/no-duplicate-types': 'error',
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
