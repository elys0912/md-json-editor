// lint の設定（flat config）
// 型情報付きの規則は、tsconfig.json の include と同じ範囲に files で当てる。ignores で外す形にすると、
// tsconfig の外のファイルが増えたときに lint 全体が型情報を引けずに止まるため

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const TYPED_FILES = ['src/**/*.ts', 'test/**/*.ts', '*.config.ts'];

export default defineConfig(
  { ignores: ['dist/', 'dev-dist/', 'node_modules/', '.local/'] },
  {
    files: TYPED_FILES,
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 数値をテンプレート文字列に入れる形は読みやすいので許す
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
);
