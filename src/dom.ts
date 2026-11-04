// 画面の要素を作る小さな補助。文字は textContent で入れる（利用者由来の文字列を HTML として解釈しない。N2-4）

export function createElement<K extends keyof HTMLElementTagNameMap>(name: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(name);

  element.className = className;

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

export function createButton(className: string, text: string, onClick?: () => void): HTMLButtonElement {
  const button = createElement('button', className, text);

  button.type = 'button';

  if (onClick !== undefined) {
    button.addEventListener('click', onClick);
  }

  return button;
}
