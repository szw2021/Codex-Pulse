const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  yoloEnabled: false,
  sessionTitleMode: 'prompt',
  completionTrackingStartedAt: 0,
  acknowledgedCompletions: [],
  remoteHosts: [],
});

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = { ...DEFAULTS };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = {
          yoloEnabled: Boolean(parsed.yoloEnabled),
          sessionTitleMode: parsed.sessionTitleMode === 'title' ? 'title' : 'prompt',
          completionTrackingStartedAt: Number(parsed.completionTrackingStartedAt) || 0,
          acknowledgedCompletions: Array.isArray(parsed.acknowledgedCompletions)
            ? parsed.acknowledgedCompletions.filter((item) => typeof item === 'string')
            : [],
          remoteHosts: Array.isArray(parsed.remoteHosts)
            ? parsed.remoteHosts.filter((item) => typeof item === 'string')
            : [],
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Unable to load settings:', error);
    }

    if (this.value.completionTrackingStartedAt <= 0) {
      this.value.completionTrackingStartedAt = Date.now();
      this.save();
    }
    return { ...this.value };
  }

  update(patch) {
    this.value = { ...this.value, ...patch };
    this.save();
    return { ...this.value };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}

module.exports = { SettingsStore };
