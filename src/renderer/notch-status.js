(() => {
  const priorities = new Map([
    ['attention', 0],
    ['active', 1],
    ['completed_pending', 2],
    ['failed', 3],
  ]);
  const meta = {
    attention: { label: '等待处理', mark: '!' },
    active: { label: '正在进行', mark: '∿' },
    completed_pending: { label: '任务已完成', mark: '✓' },
    failed: { label: '执行失败', mark: '×' },
    idle: { label: 'Codex Pulse', mark: '·' },
  };
  const elements = {
    root: document.querySelector('#notch-status'),
    mark: document.querySelector('#status-mark'),
    label: document.querySelector('#status-label'),
    detail: document.querySelector('#status-detail'),
    count: document.querySelector('#status-count'),
  };

  function sessionSummary(session, titleMode) {
    const title = titleMode === 'title'
      ? session.title
      : (session.lastPrompt || session.title);
    return [session.projectName, title || session.detail].filter(Boolean).join(' · ');
  }

  function render(payload = {}) {
    const sessions = [
      ...(Array.isArray(payload.sessions) ? payload.sessions : []),
      ...(Array.isArray(payload.remoteSessions) ? payload.remoteSessions : []),
    ].filter(session => priorities.has(session?.state));
    sessions.sort((left, right) => {
      const priority = priorities.get(left.state) - priorities.get(right.state);
      return priority || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
    });

    const remoteErrors = payload.remoteErrors && typeof payload.remoteErrors === 'object'
      ? Object.keys(payload.remoteErrors).length
      : 0;
    const scannerErrors = remoteErrors + Number(typeof payload.error === 'string');
    const selected = sessions[0];
    const state = selected?.state || (scannerErrors ? 'failed' : 'idle');
    const stateMeta = meta[state] || meta.idle;
    const detail = selected
      ? sessionSummary(selected, payload.sessionTitleMode) || selected.detail || '会话状态已更新'
      : (scannerErrors ? `${scannerErrors} 个扫描错误` : '当前没有需要关注的会话');
    const focusCount = sessions.length + scannerErrors;

    elements.root.dataset.state = state;
    elements.mark.textContent = stateMeta.mark;
    elements.label.textContent = stateMeta.label;
    elements.detail.textContent = detail;
    elements.detail.title = detail;
    elements.count.hidden = focusCount <= 1;
    elements.count.textContent = String(focusCount);
    elements.root.setAttribute('aria-label', `${stateMeta.label}：${detail}；打开 Codex Pulse`);
  }

  elements.root.addEventListener('click', () => window.codexPulse?.send('showMain'));
  window.codexPulse?.onState(render);
  window.codexPulse?.send('ready');
})();
