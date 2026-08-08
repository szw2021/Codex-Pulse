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
    assert.equal(initial.windowPinned, false);
    assert.deepEqual(initial.displayLimits, {
      active: 4,
      completed_pending: 3,
      failed: 1,
    });
    assert.equal(initial.titleLines, 1);

    const store = new SettingsStore(settingsPath);
    store.load();
    store.update({ sessionTitleMode: 'title', windowPinned: true });

    const reloaded = new SettingsStore(settingsPath).load();
    assert.equal(reloaded.sessionTitleMode, 'title');
    assert.equal(reloaded.windowPinned, true);
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

test('normalizes display counts and title line preferences', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-settings-'));
  const settingsPath = path.join(root, 'settings.json');

  try {
    await fs.writeFile(settingsPath, JSON.stringify({
      displayLimits: {
        focus: 6,
        active: 0,
        completed_pending: 9,
        failed: 2,
      },
      titleLines: 2,
    }));
    const settings = new SettingsStore(settingsPath).load();
    assert.deepEqual(settings.displayLimits, {
      active: 4,
      completed_pending: 3,
      failed: 2,
    });
    assert.equal(settings.titleLines, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
