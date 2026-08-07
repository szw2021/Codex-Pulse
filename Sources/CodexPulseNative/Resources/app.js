(() => {
  const stateMeta = {
    active: { label: '进行中', mark: '∿' },
    completed_pending: { label: '完成待确认', mark: '◎' },
    completed: { label: '已完成', mark: '✓' },
    attention: { label: '待确认', mark: '!' },
    failed: { label: '执行失败', mark: '×' },
  };

  const appState = {
    sessions: [],
    remoteSessions: [],
    remoteHosts: [],
    discoveredRemoteHosts: [],
    remoteErrors: {},
    remoteConfigError: null,
    remoteFilter: 'all',
    source: 'local',
    filter: 'all',
    query: '',
    error: null,
    remoteLoading: false,
    yoloEnabled: false,
    refreshedAt: null,
    remoteRefreshedAt: null,
  };

  const elements = {
    subtitle: document.querySelector('#subtitle'),
    list: document.querySelector('#session-list'),
    empty: document.querySelector('#empty-state'),
    search: document.querySelector('#search-input'),
    refresh: document.querySelector('#refresh-button'),
    menuButton: document.querySelector('#menu-button'),
    menu: document.querySelector('#menu'),
    yoloToggle: document.querySelector('#yolo-toggle'),
    yoloBanner: document.querySelector('#yolo-banner'),
    remoteToolbar: document.querySelector('#remote-toolbar'),
    remoteFilter: document.querySelector('#remote-filter'),
    manageRemoteButton: document.querySelector('#manage-remote-button'),
    manageRemoteMenu: document.querySelector('#manage-remote-menu'),
    remoteModal: document.querySelector('#remote-modal'),
    remoteModalClose: document.querySelector('#remote-modal-close'),
    remoteForm: document.querySelector('#remote-form'),
    remoteHostInput: document.querySelector('#remote-host-input'),
    remoteFormError: document.querySelector('#remote-form-error'),
    remoteHostList: document.querySelector('#remote-host-list'),
    discoveredHostList: document.querySelector('#discovered-host-list'),
    reloadSSHHosts: document.querySelector('#reload-ssh-hosts'),
    emptyAction: document.querySelector('#empty-action'),
    health: document.querySelector('#health-dot'),
    footerLabel: document.querySelector('#footer-label'),
    refreshedAt: document.querySelector('#refreshed-at'),
  };

  const bridge = (action, details = {}) => {
    window.webkit?.messageHandlers?.codexPulse?.postMessage({ action, ...details });
  };

  const currentSessions = () => {
    if (appState.source !== 'remote') return appState.sessions;
    if (appState.remoteFilter === 'all') return appState.remoteSessions;
    return appState.remoteSessions.filter(session => session.remoteHost === appState.remoteFilter);
  };
  const currentError = () => {
    if (appState.source !== 'remote') return appState.error;
    if (appState.remoteConfigError) return appState.remoteConfigError;
    if (appState.remoteFilter !== 'all') return appState.remoteErrors[appState.remoteFilter] || null;
    if (appState.remoteSessions.length === 0) {
      const first = Object.entries(appState.remoteErrors)[0];
      if (first) return `${first[0]} · ${first[1]}`;
    }
    return null;
  };
  const count = state => currentSessions().filter(session => session.state === state).length;

  function receive(payload) {
    appState.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    appState.remoteSessions = Array.isArray(payload.remoteSessions) ? payload.remoteSessions : [];
    appState.remoteHosts = Array.isArray(payload.remoteHosts) ? payload.remoteHosts : [];
    appState.discoveredRemoteHosts = Array.isArray(payload.discoveredRemoteHosts) ? payload.discoveredRemoteHosts : [];
    appState.remoteErrors = payload.remoteErrors && typeof payload.remoteErrors === 'object' ? payload.remoteErrors : {};
    appState.remoteConfigError = typeof payload.remoteConfigError === 'string' ? payload.remoteConfigError : null;
    appState.error = typeof payload.error === 'string' ? payload.error : null;
    appState.remoteLoading = Boolean(payload.remoteLoading);
    if (typeof payload.yoloEnabled === 'boolean') appState.yoloEnabled = payload.yoloEnabled;
    appState.refreshedAt = payload.refreshedAt || Date.now();
    appState.remoteRefreshedAt = payload.remoteRefreshedAt || null;
    elements.reloadSSHHosts.textContent = '重新读取';
    render();
  }

  function render() {
    document.body.classList.toggle('yolo-enabled', appState.yoloEnabled);
    elements.yoloToggle.classList.toggle('enabled', appState.yoloEnabled);
    elements.yoloToggle.setAttribute('aria-checked', String(appState.yoloEnabled));
    elements.yoloBanner.hidden = !appState.yoloEnabled;
    elements.refresh.classList.toggle('spinning', appState.source === 'remote' && appState.remoteLoading);
    renderRemoteControls();

    document.querySelectorAll('[data-source]').forEach(button => {
      button.classList.toggle('selected', button.dataset.source === appState.source);
    });

    for (const state of Object.keys(stateMeta)) {
      document.querySelector(`#count-${state}`).textContent = String(count(state));
    }

    const completedPending = count('completed_pending');
    const attention = count('attention');
    const active = count('active');
    elements.subtitle.textContent = completedPending > 0
      ? `有 ${completedPending} 个任务完成待确认`
      : attention > 0
      ? `有 ${attention} 个会话需要你处理`
      : active > 0
        ? `${active} 个${appState.source === 'remote' ? '远程' : '本地'}会话正在执行`
        : appState.source === 'remote' ? '远程服务器上的 Codex 会话' : '所有本地会话都已安静下来';

    document.querySelectorAll('[data-filter]').forEach(button => {
      button.classList.toggle('selected', button.dataset.filter === appState.filter);
    });
    document.querySelectorAll('[data-summary]').forEach(button => {
      button.classList.toggle('selected', button.dataset.summary === appState.filter);
    });

    const query = appState.query.trim().toLocaleLowerCase('zh-CN');
    const sessions = currentSessions();
    const visible = sessions.filter(session => {
      const stateMatches = appState.filter === 'all' || session.state === appState.filter;
      const textMatches = !query || `${session.lastPrompt || ''} ${session.title} ${session.cwd} ${session.remoteHost || ''}`.toLocaleLowerCase('zh-CN').includes(query);
      return stateMatches && textMatches;
    });

    elements.list.replaceChildren(...visible.map(createSessionRow));
    renderEmptyState(visible.length);

    const error = currentError();
    const failedRemoteHosts = Object.keys(appState.remoteErrors).length;
    elements.health.classList.toggle('error', Boolean(error) || (appState.source === 'remote' && failedRemoteHosts > 0));
    elements.health.classList.toggle('remote', appState.source === 'remote' && !error && failedRemoteHosts === 0);
    elements.health.classList.toggle('yolo', appState.source === 'local' && appState.yoloEnabled && !error);
    elements.footerLabel.textContent = error || (appState.source === 'remote'
      ? (failedRemoteHosts > 0
        ? `${failedRemoteHosts} 台服务器连接失败 · 其余结果已显示`
        : appState.remoteLoading
          ? '正在通过 SSH 读取远程会话…'
          : `SSH 远程同步 · ${appState.remoteHosts.length} 台服务器`)
      : (appState.yoloEnabled ? 'YOLO 已开启 · 跳过审批与沙箱' : '每 2 秒同步 · 数据仅在本机读取'));
    const refreshedAt = appState.source === 'remote' ? appState.remoteRefreshedAt : appState.refreshedAt;
    elements.refreshedAt.textContent = refreshedAt
      ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(refreshedAt)
      : '';
    elements.search.placeholder = appState.source === 'remote' ? '搜索远程会话、项目或服务器' : '搜索会话或项目';
  }

  function renderRemoteControls() {
    elements.remoteToolbar.hidden = appState.source !== 'remote';
    if (appState.remoteFilter !== 'all' && !appState.remoteHosts.includes(appState.remoteFilter)) {
      appState.remoteFilter = 'all';
    }
    const options = [new Option('全部服务器', 'all')];
    for (const host of appState.remoteHosts) options.push(new Option(host, host));
    elements.remoteFilter.replaceChildren(...options);
    elements.remoteFilter.value = appState.remoteFilter;
    elements.remoteFormError.hidden = !appState.remoteConfigError;
    elements.remoteFormError.textContent = appState.remoteConfigError || '';

    if (appState.remoteHosts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'remote-host-empty';
      empty.textContent = '还没有配置远程服务器';
      elements.remoteHostList.replaceChildren(empty);
    } else {
      elements.remoteHostList.replaceChildren(...appState.remoteHosts.map(host => {
        const item = document.createElement('div');
        item.className = `remote-host-item${appState.remoteErrors[host] ? ' has-error' : ''}`;
        const light = document.createElement('span');
        light.className = 'host-light';
        const copy = document.createElement('span');
        copy.className = 'remote-host-copy';
        const name = document.createElement('strong');
        name.textContent = host;
        const detail = document.createElement('small');
        const sessionCount = appState.remoteSessions.filter(session => session.remoteHost === host).length;
        detail.textContent = appState.remoteErrors[host] || `${sessionCount} 个 Codex 会话`;
        copy.append(name, detail);
        const connect = document.createElement('button');
        connect.textContent = '连接';
        connect.addEventListener('click', () => bridge('remoteConnect', { host }));
        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '移除';
        remove.addEventListener('click', () => bridge('removeRemoteHost', { host }));
        item.append(light, copy, connect, remove);
        return item;
      }));
    }

    if (appState.discoveredRemoteHosts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'remote-host-empty compact';
      empty.textContent = '没有发现具体的 Host 别名';
      elements.discoveredHostList.replaceChildren(empty);
      return;
    }
    elements.discoveredHostList.replaceChildren(...appState.discoveredRemoteHosts.map(host => {
      const alreadyAdded = appState.remoteHosts.includes(host);
      const item = document.createElement('div');
      item.className = 'remote-host-item discovered';
      const light = document.createElement('span');
      light.className = 'host-light';
      const copy = document.createElement('span');
      copy.className = 'remote-host-copy';
      const name = document.createElement('strong');
      name.textContent = host;
      const detail = document.createElement('small');
      detail.textContent = 'SSH config';
      copy.append(name, detail);
      const add = document.createElement('button');
      add.textContent = alreadyAdded ? '已添加' : '添加';
      add.disabled = alreadyAdded;
      add.addEventListener('click', () => bridge('addRemoteHost', { host }));
      item.append(light, copy, add);
      return item;
    }));
  }

  function renderEmptyState(visibleCount) {
    elements.empty.hidden = visibleCount > 0;
    elements.empty.classList.remove('loading');
    if (visibleCount > 0) return;

    const icon = elements.empty.querySelector('.empty-icon');
    const title = elements.empty.querySelector('strong');
    const detail = elements.empty.querySelector('span');
    const error = currentError();
    const sessions = currentSessions();
    elements.emptyAction.hidden = true;
    elements.emptyAction.dataset.action = '';
    delete elements.emptyAction.dataset.host;
    if (appState.source === 'remote' && appState.remoteHosts.length === 0) {
      icon.textContent = '⇄';
      title.textContent = '尚未配置远程服务器';
      detail.textContent = '添加 SSH 主机或别名后，即可查看服务器上的 Codex 会话。';
      elements.emptyAction.hidden = false;
      elements.emptyAction.textContent = '添加远程服务器';
      elements.emptyAction.dataset.action = 'remoteManage';
    } else if (appState.source === 'remote' && appState.remoteLoading && sessions.length === 0) {
      icon.textContent = '⇄';
      title.textContent = '正在读取远程服务器';
      detail.textContent = '正在通过 SSH 扫描服务器上的 ~/.codex。';
    } else if (error) {
      icon.textContent = '!';
      title.textContent = appState.source === 'remote' ? '无法读取远程会话' : '无法读取 Codex 会话';
      detail.textContent = error;
      if (appState.source === 'remote') {
        elements.emptyAction.hidden = false;
        if (appState.remoteFilter !== 'all') {
          elements.emptyAction.textContent = '在终端连接这台服务器';
          elements.emptyAction.dataset.action = 'remoteConnect';
          elements.emptyAction.dataset.host = appState.remoteFilter;
        } else {
          elements.emptyAction.textContent = '管理远程服务器';
          elements.emptyAction.dataset.action = 'remoteManage';
        }
      }
    } else if (sessions.length === 0) {
      icon.textContent = appState.source === 'remote' ? '⇄' : '>_';
      title.textContent = appState.source === 'remote' ? '没有远程 Codex 会话' : '还没有 Codex 会话';
      detail.textContent = appState.source === 'remote'
        ? '已连接服务器，但没有找到可显示的本地 Codex 会话。'
        : '启动一个 codex_cli 会话后，它会出现在这里。';
      if (appState.source === 'remote') {
        elements.emptyAction.hidden = false;
        elements.emptyAction.textContent = '管理远程服务器';
        elements.emptyAction.dataset.action = 'remoteManage';
      }
    } else {
      icon.textContent = '⌕';
      title.textContent = appState.source === 'remote' ? '没有匹配的远程会话' : '没有匹配的会话';
      detail.textContent = '切换状态或修改搜索词查看其他内容。';
    }
  }

  function createSessionRow(session) {
    const meta = stateMeta[session.state] || stateMeta.completed;
    const row = document.createElement('article');
    row.className = 'session-row';
    row.dataset.state = session.state;

    const top = document.createElement('div');
    top.className = 'row-top';

    const mark = document.createElement('span');
    mark.className = session.state === 'active' ? 'state-mark spinner' : 'state-mark';
    if (session.state !== 'active') mark.textContent = meta.mark;

    const copy = document.createElement('div');
    copy.className = 'row-copy';
    const title = document.createElement('h2');
    title.className = 'row-title';
    title.textContent = session.lastPrompt || session.title;
    title.title = session.lastPrompt || session.title;

    const detail = document.createElement('div');
    detail.className = 'row-detail';
    const stateLabel = document.createElement('span');
    stateLabel.className = 'state-label';
    stateLabel.textContent = meta.label;
    const dot = document.createElement('span');
    dot.textContent = '·';
    const detailText = document.createElement('span');
    detailText.className = 'detail-text';
    detailText.textContent = session.detail;
    detail.append(stateLabel, dot, detailText);
    copy.append(title, detail);

    const time = document.createElement('time');
    time.className = 'row-time';
    time.textContent = relativeTime(session.updatedAt);
    top.append(mark, copy, time);

    const bottom = document.createElement('div');
    bottom.className = 'row-bottom';
    const project = document.createElement('span');
    project.className = 'project';
    project.title = session.source === 'remote' ? `${session.remoteHost} · ${session.cwd}` : session.cwd;
    const folder = document.createElement('span');
    folder.className = 'folder';
    folder.textContent = session.source === 'remote' ? '⇄' : '◆';
    const projectLabel = session.source === 'remote'
      ? `${session.remoteHost} · ${session.projectName || '远程目录'}`
      : session.projectName;
    project.append(folder, document.createTextNode(projectLabel || ''));
    bottom.append(project);
    if (session.model) {
      const sep = document.createElement('span');
      sep.textContent = '·';
      const model = document.createElement('span');
      model.className = 'model';
      model.textContent = session.model;
      bottom.append(sep, model);
    }

    const shortId = document.createElement('span');
    shortId.className = 'short-id';
    shortId.textContent = `#${session.shortId}`;
    const actions = document.createElement('span');
    actions.className = 'row-actions';
    if (session.source === 'remote') {
      actions.append(
        actionButton('remoteCopy', appState.yoloEnabled ? '复制远程 YOLO 继续命令' : '复制远程继续命令', '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', session.id),
        actionButton('remoteConnect', '在终端连接服务器', '<path d="M5 4h14v16H5z"/><path d="m8 9 3 3-3 3m5 0h3"/>', session.id, { host: session.remoteHost }),
        actionButton('remoteResume', appState.yoloEnabled ? '通过 SSH 以 YOLO 模式继续' : '通过 SSH 继续会话', '<path d="M8 7 4 12l4 5M16 7l4 5-4 5M10 19l4-14"/>', session.id),
      );
    } else {
      actions.append(
        actionButton('copy', appState.yoloEnabled ? '复制 YOLO 继续命令' : '复制继续命令', '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', session.id),
        actionButton('reveal', '在 Finder 中显示项目', '<path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/>', session.id),
        actionButton('resume', appState.yoloEnabled ? '以 YOLO 模式在终端中继续' : '在终端中继续', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>', session.id),
      );
    }
    bottom.append(shortId, actions);
    row.append(top);
    if (session.state === 'completed_pending' && session.completionKey) {
      const review = document.createElement('div');
      review.className = 'completion-review';
      const acknowledge = document.createElement('button');
      acknowledge.className = 'acknowledge-button';
      acknowledge.textContent = '确认完成';
      acknowledge.addEventListener('click', event => {
        event.stopPropagation();
        acknowledge.disabled = true;
        acknowledge.textContent = '已确认';
        bridge('acknowledgeCompletion', { id: session.id, completionKey: session.completionKey });
      });
      review.append(acknowledge);
      row.append(review);
    }
    row.append(bottom);
    return row;
  }

  function actionButton(action, label, svg, id, details = {}) {
    const button = document.createElement('button');
    button.className = 'action-button';
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>`;
    button.addEventListener('click', event => {
      event.stopPropagation();
      bridge(action, { id, ...details });
      if (action === 'copy' || action === 'remoteCopy') {
        const original = button.innerHTML;
        button.textContent = '✓';
        setTimeout(() => { button.innerHTML = original; }, 1000);
      }
    });
    return button;
  }

  function relativeTime(timestamp) {
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto', style: 'narrow' });
    if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
    return formatter.format(Math.round(hours / 24), 'day');
  }

  document.querySelectorAll('[data-filter]').forEach(button => {
    button.addEventListener('click', () => { appState.filter = button.dataset.filter; render(); });
  });
  document.querySelectorAll('[data-summary]').forEach(button => {
    button.addEventListener('click', () => {
      appState.filter = appState.filter === button.dataset.summary ? 'all' : button.dataset.summary;
      render();
    });
  });
  document.querySelectorAll('[data-source]').forEach(button => {
    button.addEventListener('click', () => {
      if (appState.source === button.dataset.source) return;
      appState.source = button.dataset.source;
      appState.filter = 'all';
      render();
      bridge('setSource', { source: appState.source });
    });
  });
  elements.remoteFilter.addEventListener('change', () => {
    appState.remoteFilter = elements.remoteFilter.value;
    appState.filter = 'all';
    render();
  });
  elements.search.addEventListener('input', () => { appState.query = elements.search.value; render(); });
  elements.refresh.addEventListener('click', () => {
    elements.refresh.classList.add('spinning');
    bridge(appState.source === 'remote' ? 'refreshRemote' : 'refresh');
  });
  elements.emptyAction.addEventListener('click', () => {
    const action = elements.emptyAction.dataset.action;
    if (action === 'remoteManage') openRemoteModal();
    else if (action) bridge(action, { host: elements.emptyAction.dataset.host || '' });
  });
  const openRemoteModal = () => {
    elements.remoteModal.hidden = false;
    elements.menu.hidden = true;
    bridge('reloadSSHHosts');
    setTimeout(() => elements.remoteHostInput.focus(), 0);
  };
  const closeRemoteModal = () => { elements.remoteModal.hidden = true; };
  elements.manageRemoteButton.addEventListener('click', openRemoteModal);
  elements.manageRemoteMenu.addEventListener('click', openRemoteModal);
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
  elements.yoloToggle.addEventListener('click', event => {
    event.stopPropagation();
    appState.yoloEnabled = !appState.yoloEnabled;
    render();
    bridge('setYolo', { enabled: appState.yoloEnabled });
  });
  elements.menuButton.addEventListener('click', event => {
    event.stopPropagation();
    elements.menu.hidden = !elements.menu.hidden;
  });
  document.addEventListener('click', () => { elements.menu.hidden = true; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.remoteModal.hidden) closeRemoteModal();
  });
  document.querySelectorAll('[data-menu-action]').forEach(button => {
    button.addEventListener('click', () => bridge(button.dataset.menuAction));
  });
  document.querySelector('#drag-region').addEventListener('mousedown', event => {
    if (!event.target.closest('button, input, .menu')) bridge('drag');
  });

  window.CodexPulse = { receive };
})();
