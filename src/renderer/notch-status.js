(() => {
  const DISPLAY_DURATION = 6000;
  const RETRACT_DURATION = 180;
  const meta = {
    attention: { label: '等待处理', mark: '!' },
    active: { label: '正在进行', mark: '∿' },
    completed_pending: { label: '任务已完成', mark: '✓' },
    failed: { label: '执行失败', mark: '×' },
  };
  const elements = {
    root: document.querySelector('#notch-status'),
    mark: document.querySelector('#status-mark'),
    label: document.querySelector('#status-label'),
    detail: document.querySelector('#status-detail'),
    count: document.querySelector('#status-count'),
  };
  let snapshot = null;
  let armed = false;
  let presenting = false;
  let hovered = false;
  let remaining = DISPLAY_DURATION;
  let deadline = 0;
  let hideTimer = 0;
  let nativeHideTimer = 0;
  let presentationToken = 0;

  function sessionSummary(session, titleMode) {
    const title = titleMode === 'title'
      ? session.title
      : (session.lastPrompt || session.title);
    return [session.projectName, title || session.detail].filter(Boolean).join(' · ');
  }

  function render(session, payload, focusCount) {
    const stateMeta = meta[session.state];
    const detail = sessionSummary(session, payload.sessionTitleMode)
      || session.detail
      || '会话状态已更新';
    elements.root.dataset.state = session.state;
    elements.mark.textContent = stateMeta.mark;
    elements.label.textContent = stateMeta.label;
    elements.detail.textContent = detail;
    elements.detail.title = detail;
    elements.count.hidden = focusCount <= 1;
    elements.count.textContent = String(focusCount);
    elements.root.setAttribute('aria-label', `${stateMeta.label}：${detail}；打开 Codex Pulse`);
  }

  function clearTimers() {
    window.clearTimeout(hideTimer);
    window.clearTimeout(nativeHideTimer);
    hideTimer = 0;
    nativeHideTimer = 0;
  }

  function dismiss(immediate = false) {
    if (!presenting && !immediate) return;
    presenting = false;
    hovered = false;
    presentationToken += 1;
    clearTimers();
    elements.root.classList.remove('presenting');
    const hide = () => window.codexPulse?.send('hideNotchStatus');
    if (immediate) hide();
    else nativeHideTimer = window.setTimeout(hide, RETRACT_DURATION);
  }

  function scheduleDismiss() {
    window.clearTimeout(hideTimer);
    if (!presenting || hovered) return;
    deadline = Date.now() + remaining;
    hideTimer = window.setTimeout(() => dismiss(), remaining);
  }

  function present(session, payload, focusCount) {
    clearTimers();
    presenting = true;
    remaining = DISPLAY_DURATION;
    render(session, payload, focusCount);
    const token = ++presentationToken;
    const shown = window.codexPulse?.send('showNotchStatus');
    Promise.resolve(shown).then(() => {
      if (!presenting || token !== presentationToken) return;
      elements.root.classList.remove('presenting');
      void elements.root.offsetWidth;
      window.requestAnimationFrame(() => {
        if (presenting && token === presentationToken) {
          elements.root.classList.add('presenting');
        }
      });
    });
    scheduleDismiss();
  }

  function handleState(payload = {}) {
    const result = window.notchState.diff(snapshot, payload);
    snapshot = result.snapshot;

    if (!payload.sessionStateReady || !armed) {
      armed = Boolean(payload.sessionStateReady);
      dismiss(true);
      return;
    }
    if (!payload.notchStatusEnabled || !payload.notchStatusSupported) {
      dismiss(true);
      return;
    }
    if (result.selected) present(result.selected, payload, result.focusCount);
  }

  elements.root.addEventListener('mouseenter', () => {
    if (!presenting) return;
    hovered = true;
    remaining = Math.max(0, deadline - Date.now());
    window.clearTimeout(hideTimer);
  });
  elements.root.addEventListener('mouseleave', () => {
    if (!presenting) return;
    hovered = false;
    scheduleDismiss();
  });
  elements.root.addEventListener('click', () => {
    window.codexPulse?.send('showMain');
    dismiss();
  });
  window.codexPulse?.onState(handleState);
  window.codexPulse?.send('ready');
})();
