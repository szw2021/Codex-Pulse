(() => {
  function previewButton(session, openPreview) {
    const button = document.createElement('button');
    button.className = 'action-button';
    button.title = '查看详情和管理会话';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>';
    button.addEventListener('click', event => {
      event.stopPropagation();
      openPreview(session);
    });
    return button;
  }

  function configurePreviewManagement(elements, session, resumeBlocked) {
    const claudeSession = session.agent === 'claude';
    elements.sessionPreviewRenameAction.dataset.sessionId = session.id;
    elements.sessionPreviewRenameAction.dataset.currentName = session.title || session.lastPrompt || '';
    elements.sessionPreviewRenameAction.textContent = claudeSession ? 'Claude 暂不可重命名' : '重命名';
    elements.sessionPreviewRenameAction.disabled = claudeSession;
    elements.sessionPreviewDeleteAction.dataset.sessionId = session.id;
    elements.sessionPreviewDeleteAction.textContent = resumeBlocked
      ? '运行中不可删除'
      : (claudeSession ? 'Claude 暂不可删除' : '删除会话');
    elements.sessionPreviewDeleteAction.disabled = resumeBlocked || claudeSession;
  }

  window.codexPulseSessionActions = Object.freeze({ previewButton, configurePreviewManagement });
})();
