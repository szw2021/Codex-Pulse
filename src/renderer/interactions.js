(() => {
  function install({
    appState,
    elements,
    bridge,
    render,
    receive,
    normalizeDisplayLimit,
    defaultDisplayLimits,
    scheduleWindowHeight,
    closeSessionPreview,
    closeSessionContextMenu,
  }) {
    document.querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => {
        appState.filter = button.dataset.filter;
        render();
      });
    });
    elements.search.addEventListener('input', () => {
      appState.query = elements.search.value;
      render();
    });
    elements.refresh.addEventListener('click', () => {
      elements.refresh.classList.add('spinning');
      bridge('refresh');
    });
    elements.pinButton.addEventListener('click', () => {
      appState.windowPinned = !appState.windowPinned;
      render();
      bridge('setWindowPinned', { pinned: appState.windowPinned });
    });
    elements.minimizeButton.addEventListener('click', () => bridge('minimize'));

    const openRemoteModal = () => {
      closeSessionPreview();
      elements.remoteModal.hidden = false;
      elements.displaySettingsModal.hidden = true;
      elements.codexHomeModal.hidden = true;
      elements.menu.hidden = true;
      bridge('reloadSSHHosts');
      scheduleWindowHeight();
      setTimeout(() => elements.remoteHostInput.focus(), 0);
    };
    const closeRemoteModal = () => {
      elements.remoteModal.hidden = true;
      scheduleWindowHeight();
    };
    const closeRenameModal = () => {
      elements.renameModal.hidden = true;
      delete elements.renameForm.dataset.sessionId;
    };
    const openRenameModal = payload => {
      if (!payload || typeof payload.id !== 'string') return;
      closeSessionPreview();
      elements.remoteModal.hidden = true;
      elements.displaySettingsModal.hidden = true;
      elements.codexHomeModal.hidden = true;
      elements.menu.hidden = true;
      elements.renameForm.dataset.sessionId = payload.id;
      elements.renameInput.value = typeof payload.currentName === 'string' ? payload.currentName : '';
      elements.renameModal.hidden = false;
      setTimeout(() => {
        elements.renameInput.focus();
        elements.renameInput.select();
      }, 0);
    };
    window.codexPulseInteractions.openRenameModal = openRenameModal;
    const closeDisplaySettings = () => {
      elements.displaySettingsModal.hidden = true;
      scheduleWindowHeight();
    };
    const updateFocusTotalPreview = () => {
      const total = [...elements.displaySettingsForm.querySelectorAll('[data-display-limit]')]
        .reduce((sum, input) => sum + normalizeDisplayLimit(input.value, 1), 0);
      elements.focusLimitTotal.textContent = `${total} 条`;
    };
    const openDisplaySettings = () => {
      closeSessionPreview();
      elements.remoteModal.hidden = true;
      elements.renameModal.hidden = true;
      elements.codexHomeModal.hidden = true;
      elements.menu.hidden = true;
      for (const input of elements.displaySettingsForm.querySelectorAll('[data-display-limit]')) {
        input.value = String(appState.displayLimits[input.dataset.displayLimit]);
      }
      updateFocusTotalPreview();
      elements.displaySettingsForm.dataset.titleLines = String(appState.titleLines);
      elements.displaySettingsForm.querySelectorAll('[data-title-lines]').forEach(button => {
        button.classList.toggle('selected', Number(button.dataset.titleLines) === appState.titleLines);
      });
      elements.displaySettingsModal.hidden = false;
      scheduleWindowHeight();
    };
    const closeCodexHome = () => {
      elements.codexHomeModal.hidden = true;
      scheduleWindowHeight();
    };
    const updateCodexHomeReset = () => {
      elements.codexHomeReset.disabled = elements.codexHomeInput.value.trim()
        === appState.defaultCodexHome;
    };
    const openCodexHome = () => {
      closeSessionPreview();
      elements.remoteModal.hidden = true;
      elements.renameModal.hidden = true;
      elements.displaySettingsModal.hidden = true;
      elements.menu.hidden = true;
      elements.codexHomeInput.value = appState.codexHome;
      elements.codexHomeSource.textContent = appState.codexHomeCustom
        ? `默认目录：${appState.defaultCodexHome}`
        : '当前使用默认目录';
      updateCodexHomeReset();
      elements.codexHomeModal.hidden = false;
      scheduleWindowHeight();
      setTimeout(() => {
        elements.codexHomeInput.focus();
        elements.codexHomeInput.select();
      }, 0);
    };

    elements.emptyAction.addEventListener('click', () => {
      const action = elements.emptyAction.dataset.action;
      if (action === 'remoteManage') openRemoteModal();
      else if (action) bridge(action, { host: elements.emptyAction.dataset.host || '' });
    });
    elements.manageRemoteMenu.addEventListener('click', openRemoteModal);
    elements.dragRegion.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      if (event.target.closest?.('button, input, select, textarea, a, [contenteditable="true"], .menu')) return;
      event.preventDefault();
      window.codexPulse?.startDragging();
    });
    elements.displaySettingsMenu.addEventListener('click', openDisplaySettings);
    elements.codexHomeMenu.addEventListener('click', openCodexHome);
    elements.sessionPreviewClose.addEventListener('click', closeSessionPreview);
    elements.sessionPreviewModal.addEventListener('click', event => {
      if (event.target === elements.sessionPreviewModal) closeSessionPreview();
    });
    elements.sessionPreviewProjectAction.addEventListener('click', () => {
      const action = elements.sessionPreviewProjectAction.dataset.action;
      const id = elements.sessionPreviewProjectAction.dataset.sessionId;
      if (action === 'remoteConnect') {
        bridge(action, { host: elements.sessionPreviewProjectAction.dataset.host || '' });
      } else if (action && id) {
        bridge(action, { id });
      }
    });
    elements.sessionPreviewTerminalAction.addEventListener('click', () => {
      const action = elements.sessionPreviewTerminalAction.dataset.action;
      const id = elements.sessionPreviewTerminalAction.dataset.sessionId;
      if (action && id) bridge(action, { id });
    });
    elements.sessionPreviewRenameAction.addEventListener('click', () => {
      const id = elements.sessionPreviewRenameAction.dataset.sessionId;
      if (!id || elements.sessionPreviewRenameAction.disabled) return;
      openRenameModal({
        id,
        currentName: elements.sessionPreviewRenameAction.dataset.currentName || '',
      });
    });
    elements.sessionPreviewDeleteAction.addEventListener('click', () => {
      const id = elements.sessionPreviewDeleteAction.dataset.sessionId;
      if (!id || elements.sessionPreviewDeleteAction.disabled) return;
      const confirmed = window.confirm('确定删除这个会话吗？\n\n会话会被归档并从列表中移除，原始会话日志不会被删除。');
      if (!confirmed) return;
      closeSessionPreview();
      bridge('archiveSession', { id });
    });
    elements.remoteModalClose.addEventListener('click', closeRemoteModal);
    elements.reloadSSHHosts.addEventListener('click', () => {
      elements.reloadSSHHosts.textContent = '读取中…';
      bridge('reloadSSHHosts');
    });
    elements.remoteModal.addEventListener('click', event => {
      if (event.target === elements.remoteModal) closeRemoteModal();
    });
    elements.remoteForm.addEventListener('submit', event => {
      event.preventDefault();
      const host = elements.remoteHostInput.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(host)) {
        elements.remoteFormError.hidden = false;
        elements.remoteFormError.textContent = '请输入 SSH 别名或 user@host，不要包含空格或命令参数。';
        return;
      }
      appState.remoteConfigError = null;
      elements.remoteHostInput.value = '';
      bridge('addRemoteHost', { host });
    });
    elements.renameModalClose.addEventListener('click', closeRenameModal);
    elements.renameCancel.addEventListener('click', closeRenameModal);
    elements.renameModal.addEventListener('click', event => {
      if (event.target === elements.renameModal) closeRenameModal();
    });
    elements.renameForm.addEventListener('submit', event => {
      event.preventDefault();
      const id = elements.renameForm.dataset.sessionId;
      const name = elements.renameInput.value.replace(/\s+/gu, ' ').trim();
      if (!id || !name) return;
      closeRenameModal();
      bridge('renameSession', { id, name });
    });
    elements.displaySettingsClose.addEventListener('click', closeDisplaySettings);
    elements.displaySettingsCancel.addEventListener('click', closeDisplaySettings);
    elements.displaySettingsModal.addEventListener('click', event => {
      if (event.target === elements.displaySettingsModal) closeDisplaySettings();
    });
    elements.displaySettingsForm.querySelectorAll('[data-step]').forEach(button => {
      button.addEventListener('click', () => {
        const input = button.closest('.number-stepper')?.querySelector('input');
        if (!input) return;
        const next = Math.max(1, Math.min(8, (Number(input.value) || 1) + Number(button.dataset.step)));
        input.value = String(next);
        updateFocusTotalPreview();
      });
    });
    elements.displaySettingsForm.querySelectorAll('[data-display-limit]').forEach(input => {
      input.addEventListener('input', updateFocusTotalPreview);
    });
    elements.displaySettingsForm.querySelectorAll('[data-title-lines]').forEach(button => {
      button.addEventListener('click', () => {
        const titleLines = Number(button.dataset.titleLines) === 2 ? 2 : 1;
        elements.displaySettingsForm.dataset.titleLines = String(titleLines);
        elements.displaySettingsForm.querySelectorAll('[data-title-lines]').forEach(candidate => {
          candidate.classList.toggle('selected', candidate === button);
        });
      });
    });
    elements.displaySettingsForm.addEventListener('submit', event => {
      event.preventDefault();
      const displayLimits = { ...defaultDisplayLimits };
      for (const input of elements.displaySettingsForm.querySelectorAll('[data-display-limit]')) {
        const key = input.dataset.displayLimit;
        displayLimits[key] = normalizeDisplayLimit(input.value, appState.displayLimits[key]);
      }
      appState.displayLimits = displayLimits;
      appState.titleLines = Number(elements.displaySettingsForm.dataset.titleLines) === 2 ? 2 : 1;
      closeDisplaySettings();
      render();
      bridge('setDisplayPreferences', {
        displayLimits: appState.displayLimits,
        titleLines: appState.titleLines,
      });
    });
    elements.codexHomeClose.addEventListener('click', closeCodexHome);
    elements.codexHomeCancel.addEventListener('click', closeCodexHome);
    elements.codexHomeModal.addEventListener('click', event => {
      if (event.target === elements.codexHomeModal) closeCodexHome();
    });
    elements.codexHomeInput.addEventListener('input', updateCodexHomeReset);
    elements.codexHomeReset.addEventListener('click', () => {
      elements.codexHomeInput.value = appState.defaultCodexHome;
      elements.codexHomeSource.textContent = '保存后使用默认目录';
      updateCodexHomeReset();
      elements.codexHomeInput.focus();
    });
    elements.codexHomeForm.addEventListener('submit', event => {
      event.preventDefault();
      const codexHome = elements.codexHomeInput.value.trim();
      if (!codexHome) return;
      closeCodexHome();
      bridge('setCodexHome', { codexHome });
    });
    elements.yoloToggle.addEventListener('click', event => {
      event.stopPropagation();
      appState.yoloEnabled = !appState.yoloEnabled;
      render();
      bridge('setYolo', { enabled: appState.yoloEnabled });
    });
    elements.notchStatusToggle.addEventListener('click', event => {
      event.stopPropagation();
      if (elements.notchStatusToggle.disabled) return;
      bridge('setNotchStatus', { enabled: !appState.notchStatusEnabled });
    });
    document.querySelectorAll('[data-session-title-mode]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const mode = button.dataset.sessionTitleMode;
        if (mode !== 'prompt' && mode !== 'title') return;
        appState.sessionTitleMode = mode;
        render();
        elements.menu.hidden = true;
        bridge('setSessionTitleMode', { mode });
      });
    });
    elements.themeButton.addEventListener('click', event => {
      event.stopPropagation();
      elements.menu.hidden = true;
      closeSessionContextMenu();
      const modes = ['system', 'light', 'dark'];
      const currentIndex = modes.indexOf(appState.themeMode);
      const mode = modes[(currentIndex + 1) % modes.length];
      appState.themeMode = window.codexPulseTheme?.apply(mode) || mode;
      render();
      bridge('setThemeMode', { mode: appState.themeMode });
    });
    elements.menuButton.addEventListener('click', event => {
      event.stopPropagation();
      closeSessionContextMenu();
      elements.menu.hidden = !elements.menu.hidden;
    });
    elements.sessionContextMenu.addEventListener('click', event => event.stopPropagation());
    elements.list.addEventListener('scroll', closeSessionContextMenu);
    document.addEventListener('click', () => {
      elements.menu.hidden = true;
      closeSessionContextMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!elements.sessionContextMenu.hidden) closeSessionContextMenu();
      else if (!elements.sessionPreviewModal.hidden) closeSessionPreview();
      else if (!elements.codexHomeModal.hidden) closeCodexHome();
      else if (!elements.displaySettingsModal.hidden) closeDisplaySettings();
      else if (!elements.renameModal.hidden) closeRenameModal();
      else if (!elements.remoteModal.hidden) closeRemoteModal();
    });
    document.querySelectorAll('[data-menu-action]').forEach(button => {
      button.addEventListener('click', () => bridge(button.dataset.menuAction));
    });
    window.codexPulse?.onState(receive);
    window.codexPulse?.onCommand(payload => {
      if (payload?.action === 'renameSession') openRenameModal(payload);
      else if (payload?.action === 'error') window.alert(payload.message || '操作失败');
    });
    bridge('ready');
  }

  window.codexPulseInteractions = { install };
})();
