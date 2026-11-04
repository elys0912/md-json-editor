// 型を同梱しないパッケージの宣言

declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it';

  // enabled: false でチェックボックスを操作不可（disabled）にする
  const taskLists: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;

  export default taskLists;
}
