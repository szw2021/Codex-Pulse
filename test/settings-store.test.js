const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SettingsStore } = require('../src/main/settings-store');

test('defaults session titles to the latest user prompt and persists changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-settings-'));
  const settingsPath = path.join(root, 'settings.json');

  try {
    const initial = new SettingsStore(settingsPath).load();
    assert.equal(initial.sessionTitleMode, 'prompt');

    const store = new SettingsStore(settingsPath);
    store.load();
    store.update({ sessionTitleMode: 'title' });

    const reloaded = new SettingsStore(settingsPath).load();
    assert.equal(reloaded.sessionTitleMode, 'title');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falls back to latest prompt for invalid stored title modes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-settings-'));
  const settingsPath = path.join(root, 'settings.json');

  try {
    await fs.writeFile(settingsPath, JSON.stringify({ sessionTitleMode: 'unexpected' }));
    const settings = new SettingsStore(settingsPath).load();
    assert.equal(settings.sessionTitleMode, 'prompt');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
