const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  clipboard,
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
  shellQuote,
} = require('./commands');
const {
  RemoteScanner,
  discoverSshHosts,
  isValidHost,
} = require('./remote-scanner');
const { SettingsStore } = require('./settings-store');

const ACTION_CHANNEL = 'codex-pulse:action';
const STATE_CHANNEL = 'codex-pulse:state';
const WINDOW_WIDTH = 370;
const WINDOW_HEIGHT = 540;

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
    this.viewingRemote = false;
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
    this.sessionTitleMode = settings.sessionTitleMode;
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
      height: WINDOW_HEIGHT,
      minWidth: WINDOW_WIDTH,
      minHeight: WINDOW_HEIGHT,
      maxWidth: WINDOW_WIDTH,
      maxHeight: WINDOW_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
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
    this.mainWindow.setAlwaysOnTop(true, 'floating');
    this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
      await this.refreshSessions();
    } else if (action === 'refreshRemote') {
      await this.refreshRemoteSessions();
    } else if (action === 'reloadSSHHosts') {
      this.discoveredRemoteHosts = discoverSshHosts();
      this.remoteConfigError = null;
      this.publishState();
    } else if (action === 'setSource' && (payload.source === 'local' || payload.source === 'remote')) {
      this.viewingRemote = payload.source === 'remote';
      if (this.viewingRemote) await this.refreshRemoteSessions();
    } else if (action === 'addRemoteHost') {
      this.addRemoteHost(payload.host);
    } else if (action === 'removeRemoteHost') {
      this.removeRemoteHost(payload.host);
    } else if (action === 'remoteConnect') {
      const host = typeof payload.host === 'string' ? payload.host : '';
      if (isValidHost(host)) launchTerminalCommand(`ssh ${shellQuote(host)}`);
    } else if (action === 'setYolo' && typeof payload.enabled === 'boolean') {
      this.setYolo(payload.enabled);
    } else if (action === 'setSessionTitleMode'
      && (payload.mode === 'prompt' || payload.mode === 'title')) {
      this.setSessionTitleMode(payload.mode);
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

  setYolo(enabled) {
    this.yoloEnabled = Boolean(enabled);
    this.settingsStore.update({ yoloEnabled: this.yoloEnabled });
    this.publishState();
  }

  setSessionTitleMode(mode) {
    this.sessionTitleMode = mode === 'title' ? 'title' : 'prompt';
    this.settingsStore.update({ sessionTitleMode: this.sessionTitleMode });
    this.publishState();
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
      this.localSessions = [];
      this.localError = error.message || '无法读取 Codex 会话';
      console.error('Unable to load local Codex sessions:', error);
    } finally {
      this.refreshInFlight = false;
      this.publishState();
    }

    if (this.viewingRemote
      && (!this.remoteRefreshedAt || Date.now() - this.remoteRefreshedAt >= 15000)) {
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
      sessionTitleMode: this.sessionTitleMode,
    });
  }

  updateTray(sessions) {
    if (!this.tray) return;
    const attention = sessions.filter((session) => session.state === 'attention').length;
    const active = sessions.filter((session) => session.state === 'active').length;
    const completedPending = sessions.filter((session) => session.state === 'completed_pending').length;
    let activityTitle = '';
    if (attention > 0) activityTitle += ` !${attention}`;
    if (completedPending > 0) activityTitle += ` ✓${completedPending}`;
    if (attention === 0 && completedPending === 0 && active > 0) activityTitle += ` ${active}`;
    this.tray.setTitle(this.yoloEnabled ? ` YOLO${activityTitle}` : activityTitle);
    if (completedPending > 0) {
      this.tray.setToolTip(`Codex Pulse · ${completedPending} 个任务完成待确认${this.yoloEnabled ? ' · YOLO 已开启' : ''}`);
    } else {
      this.tray.setToolTip(this.yoloEnabled ? 'Codex Pulse · YOLO 模式已开启' : 'Codex Pulse');
    }
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
