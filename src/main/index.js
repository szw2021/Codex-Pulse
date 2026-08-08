const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} = require('electron');
const { CodexScanner } = require('./codex-scanner');
const { sessionsByApplyingCompletionTracking } = require('./completion-tracking');
const {
  launchTerminalCommand,
  remoteResumeCommandForSession,
  resumeCommandForSession,
  sessionHasActiveWriter,
  sessionResumeBlocked,
  shellQuote,
} = require('./commands');
const {
  RemoteScanner,
  discoverSshHosts,
  isValidHost,
} = require('./remote-scanner');
const { normalizeDisplayLimits, SettingsStore } = require('./settings-store');

const ACTION_CHANNEL = 'codex-pulse:action';
const STATE_CHANNEL = 'codex-pulse:state';
const COMMAND_CHANNEL = 'codex-pulse:command';
const WINDOW_WIDTH = 370;
const WINDOW_INITIAL_HEIGHT = 360;
const WINDOW_MIN_HEIGHT = 190;
const WINDOW_MAX_HEIGHT = 1600;

function createTrayImage() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">',
    '<rect x="1.5" y="2.5" width="15" height="13" rx="2.5" fill="none" stroke="black" stroke-width="1.6"/>',
    '<path d="M4.5 6.2 7.2 8.8 4.5 11.5M9 11.5h4.3" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    '</svg>',
  ].join('');
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const image = nativeImage.createFromDataURL(dataUrl).resize({ width: 18, height: 18 });
  image.setTemplateImage(true);
  return image;
}

class CodexPulseApplication {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.refreshTimer = null;
    this.pageReady = false;
    this.quitting = false;
    this.refreshInFlight = false;
    this.remoteRefreshInFlight = false;
    this.remoteRefreshGeneration = 0;
    this.localSessions = [];
    this.remoteSessions = [];
    this.remoteErrors = {};
    this.remoteConfigError = null;
    this.localError = null;
    this.remoteRefreshedAt = null;
    this.sessionsById = new Map();
  }

  start() {
    const codexHome = process.env.CODEX_HOME || path.join(app.getPath('home'), '.codex');
    this.scanner = new CodexScanner(codexHome);
    this.remoteScanner = new RemoteScanner();
    this.settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
    const settings = this.settingsStore.load();
    this.yoloEnabled = settings.yoloEnabled;
    this.windowPinned = settings.windowPinned;
    this.sessionTitleMode = settings.sessionTitleMode;
    this.displayLimits = settings.displayLimits;
    this.titleLines = settings.titleLines;
    this.completionTrackingStartedAt = settings.completionTrackingStartedAt;
    this.acknowledgedCompletions = new Set(settings.acknowledgedCompletions);
    this.remoteHosts = [...new Set(settings.remoteHosts.filter(isValidHost))];
    this.discoveredRemoteHosts = discoverSshHosts();

    Menu.setApplicationMenu(null);
    this.configureIpc();
    this.configureTray();
    this.configureWindow();
    this.refreshTimer = setInterval(() => void this.refreshSessions(), 2000);
    void this.refreshSessions();
  }

  stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    ipcMain.removeAllListeners(ACTION_CHANNEL);
  }

  configureTray() {
    this.tray = new Tray(createTrayImage());
    this.tray.setToolTip('Codex Pulse');
    this.tray.on('click', () => this.toggleWindow());
    this.tray.on('right-click', () => this.tray.popUpContextMenu(this.trayMenu()));
  }

  trayMenu() {
    return Menu.buildFromTemplate([
      {
        label: this.mainWindow?.isVisible() ? '隐藏悬浮窗' : '显示悬浮窗',
        click: () => this.toggleWindow(),
      },
      {
        label: 'YOLO 模式',
        type: 'checkbox',
        checked: this.yoloEnabled,
        click: (item) => this.setYolo(item.checked),
      },
      { type: 'separator' },
      { label: '退出 Codex Pulse', click: () => app.quit() },
    ]);
  }

  configureWindow() {
    const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
    const rendererUrl = pathToFileURL(rendererPath).toString();
    this.mainWindow = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_INITIAL_HEIGHT,
      minWidth: WINDOW_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      maxWidth: WINDOW_WIDTH,
      maxHeight: WINDOW_MAX_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: this.windowPinned,
      skipTaskbar: false,
      hasShadow: true,
      roundedCorners: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.applyWindowPinnedState();
    this.mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url !== rendererUrl) event.preventDefault();
    });
    this.mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    this.mainWindow.webContents.on('did-finish-load', () => {
      this.pageReady = true;
      this.publishState();
    });
    this.mainWindow.once('ready-to-show', () => {
      this.showWindow();
    });
    this.mainWindow.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.mainWindow.hide();
    });
    this.mainWindow.on('restore', () => this.hideDockIcon());
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      this.pageReady = false;
    });
    void this.mainWindow.loadFile(rendererPath);
  }

  configureIpc() {
    ipcMain.on(ACTION_CHANNEL, (event, payload) => {
      if (!this.mainWindow || event.sender !== this.mainWindow.webContents) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      void this.handleAction(payload).catch((error) => {
        console.error(`Action ${payload.action || 'unknown'} failed:`, error);
      });
    });
  }

  async handleAction(payload) {
    const action = payload.action;
    if (action === 'ready') {
      this.publishState();
    } else if (action === 'refresh') {
      this.remoteRefreshedAt = null;
      await this.refreshSessions();
    } else if (action === 'reloadSSHHosts') {
      this.discoveredRemoteHosts = discoverSshHosts();
      this.remoteConfigError = null;
      this.publishState();
    } else if (action === 'addRemoteHost') {
      this.addRemoteHost(payload.host);
    } else if (action === 'removeRemoteHost') {
      this.removeRemoteHost(payload.host);
    } else if (action === 'remoteConnect') {
      const host = typeof payload.host === 'string' ? payload.host : '';
      if (isValidHost(host)) launchTerminalCommand(`ssh ${shellQuote(host)}`);
    } else if (action === 'setYolo' && typeof payload.enabled === 'boolean') {
      this.setYolo(payload.enabled);
    } else if (action === 'setWindowPinned' && typeof payload.pinned === 'boolean') {
      this.setWindowPinned(payload.pinned);
    } else if (action === 'setSessionTitleMode'
      && (payload.mode === 'prompt' || payload.mode === 'title')) {
      this.setSessionTitleMode(payload.mode);
    } else if (action === 'setDisplayPreferences') {
      this.setDisplayPreferences(payload);
    } else if (action === 'setWindowHeight') {
      this.setWindowHeight(payload.height);
    } else if (action === 'showSessionMenu' && typeof payload.id === 'string') {
      this.showSessionMenu(payload.id);
    } else if (action === 'renameSession'
      && typeof payload.id === 'string'
      && typeof payload.name === 'string') {
      await this.renameSession(payload.id, payload.name);
    } else if (action === 'minimize') {
      await this.minimizeWindow();
    } else if (action === 'hide') {
      this.mainWindow?.hide();
    } else if (action === 'quit') {
      app.quit();
    } else if (typeof payload.id === 'string') {
      this.handleSessionAction(action, payload);
    }
  }

  handleSessionAction(action, payload) {
    const session = this.sessionsById.get(payload.id);
    if (!session) return;
    if (action === 'acknowledgeCompletion') {
      if (typeof payload.completionKey === 'string'
        && payload.completionKey === session.completionKey) {
        this.acknowledgedCompletions.add(payload.completionKey);
        this.settingsStore.update({
          acknowledgedCompletions: [...this.acknowledgedCompletions].sort(),
        });
        this.publishState();
      }
      return;
    }

    const resumeBlocked = sessionResumeBlocked(session);
    if ((action === 'resume'
      || action === 'remoteResume'
      || action === 'copy'
      || action === 'remoteCopy') && resumeBlocked) {
      const owner = session.writerOwner || (session.source === 'remote' ? '远程终端' : '原终端');
      void this.showSessionOperationError(
        action === 'copy' || action === 'remoteCopy' ? '无法复制继续命令' : '无法重复继续会话',
        new Error(sessionHasActiveWriter(session)
          ? `检测到 Codex 进程 ${session.pid} 仍在${owner}中持有这个会话。请回到原终端继续，或右键选择“结束原进程并继续”。`
          : '这个会话仍在运行或等待操作，请先回到原终端处理。'),
      );
      return;
    }

    if (session.source === 'remote') {
      const command = remoteResumeCommandForSession(session, this.yoloEnabled);
      if (action === 'remoteResume') launchTerminalCommand(command);
      if (action === 'remoteCopy') clipboard.writeText(command);
      if (action === 'remoteConnect' && isValidHost(session.remoteHost)) {
        launchTerminalCommand(`ssh ${shellQuote(session.remoteHost)}`);
      }
      return;
    }

    const command = resumeCommandForSession(session, this.yoloEnabled);
    if (action === 'resume') launchTerminalCommand(command);
    if (action === 'copy') clipboard.writeText(command);
    if (action === 'reveal' && session.cwd) shell.showItemInFolder(session.cwd);
  }

  showSessionMenu(id) {
    const session = this.sessionsById.get(id);
    if (!session || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    const remote = session.source === 'remote';
    const writerActive = sessionHasActiveWriter(session);
    const resumeBlocked = sessionResumeBlocked(session);
    const deletionBlocked = writerActive || session.state === 'active' || session.state === 'attention';
    const writerOwner = session.writerOwner || (remote ? '远程终端' : '终端');
    const action = (name, details = {}) => () => this.handleSessionAction(name, { id, ...details });
    const template = remote
      ? [
        {
          label: resumeBlocked ? `会话已在${writerOwner}运行` : '通过 SSH 继续',
          enabled: !resumeBlocked,
          click: action('remoteResume'),
        },
        { label: '复制继续命令', enabled: !resumeBlocked, click: action('remoteCopy') },
        { label: '连接服务器', click: action('remoteConnect', { host: session.remoteHost }) },
      ]
      : [
        {
          label: resumeBlocked ? `会话已在${writerOwner}运行` : '在终端中继续',
          enabled: !resumeBlocked,
          click: action('resume'),
        },
        { label: '复制继续命令', enabled: !resumeBlocked, click: action('copy') },
        { label: '在 Finder 中显示项目', enabled: Boolean(session.cwd), click: action('reveal') },
      ];
    if (remote && writerActive) {
      template.push({
        label: '结束原进程并继续…',
        click: () => void this.confirmTerminateRemoteSession(id),
      });
    }
    template.push(
      { type: 'separator' },
      {
        label: '重命名…',
        click: () => this.requestSessionRename(session),
      },
      {
        label: deletionBlocked ? '运行中不可删除' : '删除会话…',
        enabled: !deletionBlocked,
        click: () => void this.confirmArchiveSession(id),
      },
    );
    Menu.buildFromTemplate(template).popup({ window: this.mainWindow });
  }

  async confirmTerminateRemoteSession(id) {
    const session = this.sessionsById.get(id);
    if (!session || session.source !== 'remote' || !sessionHasActiveWriter(session)) return;
    const owner = session.writerOwner || '远程终端';
    const tty = session.writerTty ? ` · ${session.writerTty}` : '';
    const result = await dialog.showMessageBox(this.mainWindow, {
      type: 'warning',
      buttons: ['取消', '结束并继续'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '结束原 Codex 进程',
      message: `这个会话仍在${owner}中运行`,
      detail: `PID ${session.pid}${tty}。继续会停止原会话及其正在执行的工具，然后在新终端恢复。未完成的工作可能会中断。`,
    });
    if (result.response !== 1) return;
    try {
      await this.remoteScanner.manageSession(
        session.remoteHost,
        'terminate',
        session.remoteSessionId,
        session.pid,
      );
      launchTerminalCommand(remoteResumeCommandForSession(session, this.yoloEnabled));
      this.remoteRefreshedAt = null;
      void this.refreshRemoteSessions();
    } catch (error) {
      await this.showSessionOperationError('无法结束原会话', error);
    }
  }

  requestSessionRename(session) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(COMMAND_CHANNEL, {
      action: 'renameSession',
      id: session.id,
      currentName: session.title || session.lastPrompt || '',
    });
  }

  async renameSession(id, value) {
    const session = this.sessionsById.get(id);
    if (!session) throw new Error('未找到要重命名的会话');
    const name = value.replace(/\s+/gu, ' ').trim().slice(0, 100);
    if (!name) throw new Error('会话名称不能为空');
    try {
      if (session.source === 'remote') {
        await this.remoteScanner.manageSession(
          session.remoteHost,
          'rename',
          session.remoteSessionId,
          name,
        );
        this.remoteSessions = this.remoteSessions.map((item) => (
          item.id === id ? { ...item, title: name } : item
        ));
      } else {
        await this.scanner.renameSession(session.id, name);
        this.localSessions = this.localSessions.map((item) => (
          item.id === id ? { ...item, title: name } : item
        ));
      }
      this.publishState();
    } catch (error) {
      await this.showSessionOperationError('无法重命名会话', error);
    }
  }

  async confirmArchiveSession(id) {
    const session = this.sessionsById.get(id);
    if (!session
      || sessionHasActiveWriter(session)
      || session.state === 'active'
      || session.state === 'attention') return;
    const result = await dialog.showMessageBox(this.mainWindow, {
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '删除会话',
      message: '确定删除这个会话吗？',
      detail: '会话会被归档并从列表中移除，原始会话日志不会被删除。',
    });
    if (result.response !== 1) return;
    try {
      if (session.source === 'remote') {
        await this.remoteScanner.manageSession(
          session.remoteHost,
          'archive',
          session.remoteSessionId,
        );
        this.remoteSessions = this.remoteSessions.filter((item) => item.id !== id);
      } else {
        await this.scanner.archiveSession(session.id);
        this.localSessions = this.localSessions.filter((item) => item.id !== id);
      }
      this.publishState();
    } catch (error) {
      await this.showSessionOperationError('无法删除会话', error);
    }
  }

  async showSessionOperationError(message, error) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    await dialog.showMessageBox(this.mainWindow, {
      type: 'error',
      buttons: ['好'],
      defaultId: 0,
      title: 'Codex Pulse',
      message,
      detail: error?.message || '未知错误',
    });
  }

  setYolo(enabled) {
    this.yoloEnabled = Boolean(enabled);
    this.settingsStore.update({ yoloEnabled: this.yoloEnabled });
    this.publishState();
  }

  applyWindowPinnedState() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.setAlwaysOnTop(this.windowPinned, 'floating');
    this.mainWindow.setVisibleOnAllWorkspaces(this.windowPinned, { visibleOnFullScreen: true });
  }

  setWindowPinned(pinned) {
    this.windowPinned = Boolean(pinned);
    this.applyWindowPinnedState();
    this.settingsStore.update({ windowPinned: this.windowPinned });
    this.publishState();
  }

  async minimizeWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.isMinimized()) return;
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular');
      await app.dock?.show();
    }
    this.mainWindow.minimize();
  }

  hideDockIcon() {
    if (process.platform !== 'darwin') return;
    app.dock?.hide();
    app.setActivationPolicy('accessory');
  }

  setSessionTitleMode(mode) {
    this.sessionTitleMode = mode === 'title' ? 'title' : 'prompt';
    this.settingsStore.update({ sessionTitleMode: this.sessionTitleMode });
    this.publishState();
  }

  setDisplayPreferences(payload) {
    this.displayLimits = normalizeDisplayLimits(payload.displayLimits);
    this.titleLines = payload.titleLines === 2 ? 2 : 1;
    this.settingsStore.update({
      displayLimits: this.displayLimits,
      titleLines: this.titleLines,
    });
    this.publishState();
  }

  setWindowHeight(value) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const workAreaHeight = screen.getPrimaryDisplay().workArea.height;
    const availableHeight = Math.max(WINDOW_MIN_HEIGHT, workAreaHeight - 16);
    const height = Math.max(
      WINDOW_MIN_HEIGHT,
      Math.min(WINDOW_MAX_HEIGHT, availableHeight, Math.round(Number(value) || WINDOW_INITIAL_HEIGHT)),
    );
    if (this.mainWindow.getBounds().height === height) return;
    this.mainWindow.setSize(WINDOW_WIDTH, height, false);
    this.positionWindow();
  }

  addRemoteHost(value) {
    const host = typeof value === 'string' ? value.trim() : '';
    if (!isValidHost(host)) {
      this.remoteConfigError = '请输入有效的 SSH 主机或 ~/.ssh/config 别名';
      this.publishState();
      return;
    }
    this.remoteConfigError = null;
    if (!this.remoteHosts.includes(host)) {
      this.remoteHosts = [...this.remoteHosts, host];
      this.settingsStore.update({ remoteHosts: this.remoteHosts });
    }
    this.restartRemoteRefresh();
  }

  removeRemoteHost(value) {
    if (typeof value !== 'string' || !this.remoteHosts.includes(value)) return;
    this.remoteHosts = this.remoteHosts.filter((host) => host !== value);
    this.settingsStore.update({ remoteHosts: this.remoteHosts });
    this.remoteSessions = this.remoteSessions.filter((session) => session.remoteHost !== value);
    delete this.remoteErrors[value];
    this.remoteConfigError = null;
    this.restartRemoteRefresh();
  }

  restartRemoteRefresh() {
    this.remoteRefreshGeneration += 1;
    this.remoteRefreshInFlight = false;
    this.remoteRefreshedAt = null;
    this.publishState();
    void this.refreshRemoteSessions();
  }

  async refreshSessions() {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      this.localSessions = await this.scanner.scanSessions();
      this.localError = null;
      if (process.env.CODEX_PULSE_DEBUG) {
        console.log(`Loaded ${this.localSessions.length} local Codex sessions`);
      }
    } catch (error) {
      const message = error.message || '无法读取 Codex 会话';
      if (message !== this.localError) {
        console.error('Unable to load local Codex sessions:', error);
      }
      this.localError = message;
    } finally {
      this.refreshInFlight = false;
      this.publishState();
    }

    if (!this.remoteRefreshedAt || Date.now() - this.remoteRefreshedAt >= 15000) {
      void this.refreshRemoteSessions();
    }
  }

  async refreshRemoteSessions() {
    if (this.remoteRefreshInFlight) return;
    const hosts = [...this.remoteHosts];
    const generation = ++this.remoteRefreshGeneration;
    if (hosts.length === 0) {
      this.remoteSessions = [];
      this.remoteErrors = {};
      this.remoteRefreshedAt = Date.now();
      this.publishState();
      return;
    }

    this.remoteRefreshInFlight = true;
    this.publishState();
    const results = await Promise.all(hosts.map(async (host) => {
      try {
        return { host, sessions: await this.remoteScanner.scanHost(host), error: null };
      } catch (error) {
        return { host, sessions: [], error: error.message || '无法连接远程服务器' };
      }
    }));
    if (generation !== this.remoteRefreshGeneration) return;

    this.remoteRefreshInFlight = false;
    this.remoteSessions = results.flatMap((result) => result.sessions);
    this.remoteErrors = Object.fromEntries(
      results.filter((result) => result.error).map((result) => [result.host, result.error]),
    );
    if (process.env.CODEX_PULSE_DEBUG) {
      console.log('Remote Codex refresh completed', {
        sessionCount: this.remoteSessions.length,
        errorCount: Object.keys(this.remoteErrors).length,
      });
    }
    this.remoteRefreshedAt = Date.now();
    this.publishState();
  }

  trackedSessions(sessions) {
    return sessionsByApplyingCompletionTracking(
      sessions,
      this.completionTrackingStartedAt,
      this.acknowledgedCompletions,
    );
  }

  publishState() {
    const local = this.trackedSessions(this.localSessions);
    const remote = this.trackedSessions(this.remoteSessions);
    this.sessionsById = new Map([...local, ...remote].map((session) => [session.id, session]));
    this.updateTray([...local, ...remote]);
    if (!this.pageReady || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(STATE_CHANNEL, {
      sessions: local,
      remoteSessions: remote,
      remoteHosts: this.remoteHosts,
      discoveredRemoteHosts: this.discoveredRemoteHosts,
      remoteErrors: this.remoteErrors,
      remoteConfigError: this.remoteConfigError,
      error: this.localError,
      remoteLoading: this.remoteRefreshInFlight,
      yoloEnabled: this.yoloEnabled,
      windowPinned: this.windowPinned,
      sessionTitleMode: this.sessionTitleMode,
      displayLimits: this.displayLimits,
      titleLines: this.titleLines,
    });
  }

  updateTray(sessions) {
    if (!this.tray) return;
    const attention = sessions.filter((session) => session.state === 'attention').length;
    const active = sessions.filter((session) => session.state === 'active').length;
    const completedPending = sessions.filter((session) => session.state === 'completed_pending').length;
    const failed = sessions.filter((session) => session.state === 'failed').length
      + Object.keys(this.remoteErrors).length
      + (this.localError ? 1 : 0);
    const running = attention + active;
    let activityTitle = '';
    if (running > 0) activityTitle += ` ▶${running}`;
    if (completedPending > 0) activityTitle += ` ✓${completedPending}`;
    if (failed > 0) activityTitle += ` ×${failed}`;
    this.tray.setTitle(this.yoloEnabled ? ` YOLO${activityTitle}` : activityTitle);
    const summary = [];
    if (attention > 0) summary.push(`${attention} 个等待处理`);
    if (active > 0) summary.push(`${active} 个正在进行`);
    if (completedPending > 0) summary.push(`${completedPending} 个刚完成`);
    if (failed > 0) summary.push(`${failed} 个失败`);
    if (this.yoloEnabled) summary.push('YOLO 已开启');
    this.tray.setToolTip(summary.length > 0
      ? `Codex Pulse · ${summary.join(' · ')}`
      : 'Codex Pulse · 当前没有需要关注的会话');
  }

  positionWindow() {
    if (!this.mainWindow) return;
    const windowBounds = this.mainWindow.getBounds();
    const workArea = screen.getPrimaryDisplay().workArea;
    const x = workArea.x + workArea.width - windowBounds.width - 18;
    const y = workArea.y + 8;
    if (process.env.CODEX_PULSE_DEBUG) {
      console.log('Positioning Codex Pulse window', { workArea, windowBounds, x, y });
    }
    this.mainWindow.setPosition(x, y, false);
  }

  showWindow() {
    if (!this.mainWindow) return;
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.positionWindow();
    if (process.platform === 'darwin') app.focus({ steal: true });
    this.mainWindow.show();
    this.mainWindow.focus();
    this.mainWindow.moveTop();
    void this.refreshSessions();
  }

  toggleWindow() {
    if (this.mainWindow?.isVisible()) this.mainWindow.hide();
    else this.showWindow();
  }
}

app.setName('Codex Pulse');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let pulseApplication = null;
  app.on('second-instance', () => pulseApplication?.showWindow());
  app.on('before-quit', () => {
    if (pulseApplication) pulseApplication.quitting = true;
  });
  app.on('will-quit', () => pulseApplication?.stop());
  app.on('window-all-closed', () => {});
  app.on('activate', () => pulseApplication?.showWindow());

  app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      app.setActivationPolicy('accessory');
      app.dock?.hide();
    }
    pulseApplication = new CodexPulseApplication();
    pulseApplication.start();
  }).catch((error) => {
    console.error('Codex Pulse failed to start:', error);
    app.quit();
  });
}
