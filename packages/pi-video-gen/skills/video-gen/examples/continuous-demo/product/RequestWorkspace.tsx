import React from 'react';
import './workspace.css';

export type RequestState = {
  request: string;
  status: 'draft' | 'running' | 'done';
  updates: string[];
};

// Sample business component shared by the interactive playground and the film.
export function RequestWorkspace({ request, status, updates, onChange, onSubmit }: RequestState & {
  onChange?: (value: string) => void;
  onSubmit?: () => void;
}) {
  return <section className="request-workspace" aria-label="更新整理工作区">
    <header><span className="workspace-mark">R</span><strong>Release desk</strong><span>示例产品</span></header>
    <form onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}>
      <label htmlFor="release-request">你想整理什么？</label>
      <textarea id="release-request" value={request} readOnly={!onChange}
        onChange={(event) => onChange?.(event.target.value)} placeholder="输入一个整理请求"
        disabled={status === 'running'} />
      <button type="submit" disabled={!request.trim() || status !== 'draft'}>
        {status === 'running' ? '正在整理…' : status === 'done' ? '已完成' : '整理更新'}
      </button>
    </form>
    <div className="workspace-result" aria-live="polite">
      {status === 'draft' && <p>输入请求后，更新会显示在这里。</p>}
      {status === 'running' && <p>正在读取示例更新记录…</p>}
      {status === 'done' && <><h2>已整理 {updates.length} 项更新</h2>
        <ul>{updates.map((update) => <li key={update}>{update}</li>)}</ul></>}
    </div>
    <footer>本地固定数据 · 无网络请求</footer>
  </section>;
}
