// Service Worker の登録と更新の通知（詳細設計 3.9、N1-3）
// main.ts からだけ呼ぶ。`virtual:` の import をテストから外すために分けている（テストでは読み込まない）

import { registerSW } from 'virtual:pwa-register';

/** 新しい版があると onNeedRefresh を呼ぶ。渡す update を呼ぶと新しい版で読み直す（flush と確認は呼び出し側） */
export function registerPwa(onNeedRefresh: (update: () => Promise<void>) => void): void {
  const updateServiceWorker = registerSW({
    onNeedRefresh() {
      onNeedRefresh(() => updateServiceWorker());
    },
  });
}
