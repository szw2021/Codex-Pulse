const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DISPLAY_LIMITS = Object.freeze({
  active: 4,
  completed_pending: 3,
  failed: 1,
});

const DEFAULTS = Object.freeze({
  yoloEnabled: false,
  windowPinned: false,
  sessionTitleMode: 'prompt',
  displayLimits: DEFAULT_DISPLAY_LIMITS,
  titleLines: 1,
  completionTrackingStartedAt: 0,
  acknowledgedCompletions: [],
  remoteHosts: [],
});

function displayLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 8 ? number : fallback;
}

function normalizeDisplayLimits(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_DISPLAY_LIMITS).map(([key, fallback]) => [
    key,
    displayLimit(source[key], fallback),
  ]));
}

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
          windowPinned: Boolean(parsed.windowPinned),
          sessionTitleMode: parsed.sessionTitleMode === 'title' ? 'title' : 'prompt',
          displayLimits: normalizeDisplayLimits(parsed.displayLimits),
          titleLines: parsed.titleLines === 2 ? 2 : 1,
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

module.exports = { DEFAULT_DISPLAY_LIMITS, SettingsStore, normalizeDisplayLimits };
