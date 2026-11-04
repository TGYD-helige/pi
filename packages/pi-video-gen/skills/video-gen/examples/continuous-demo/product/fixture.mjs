export const requestText = '整理本周已发布的更新';
export const updates = ['接入产品组件', '独立调整音乐与音效', '检查转场前后的画面'];
export const productEvents = { typing: 0.5, submit: 3, result: 4.5 };

/** @returns {{request: string, status: 'draft' | 'running' | 'done', updates: string[]}} */
export function stateAtTime(t) {
  const length = Math.floor(requestText.length * Math.max(0, Math.min(1,
    (t - productEvents.typing) / (productEvents.submit - productEvents.typing))));
  return {
    request: requestText.slice(0, length),
    status: t >= productEvents.result ? 'done' : t >= productEvents.submit ? 'running' : 'draft',
    updates: t >= productEvents.result ? [...updates] : [],
  };
}
