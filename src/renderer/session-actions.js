(() => {
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

  window.codexPulseSessionActions = Object.freeze({ configurePreviewManagement });
})();
