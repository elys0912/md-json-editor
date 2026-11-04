// ビルドとテストの設定。PWA の設定は詳細設計 3.9、テストの環境は詳細設計 5

import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// GitHub Pages の公開先のパス（https://<owner>.github.io/md-json-editor/）
const BASE_PATH = '/md-json-editor/';

// style.css の --accent と同じ色
const THEME_COLOR = '#2f6feb';

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      pwaAssets: {
        image: 'public/icon.svg',
        preset: 'minimal-2023',
      },
      manifest: {
        name: 'md-json-editor',
        short_name: 'md-json-editor',
        description: 'オフラインで動く Markdown・JSON のビューワー兼エディタ',
        lang: 'ja',
        display: 'standalone',
        start_url: BASE_PATH,
        scope: BASE_PATH,
        theme_color: THEME_COLOR,
        background_color: '#ffffff',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
