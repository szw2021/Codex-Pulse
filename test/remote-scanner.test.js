const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  hostsFromSshConfig,
  isValidHost,
  sessionsFromJsonData,
} = require('../src/main/remote-scanner');

test('normalizes remote sessions and completion keys', () => {
  const fixture = JSON.stringify({
    sessions: [
      {
        id: 'remote-session-123',
        title: '远程标题',
        lastPrompt: '服务器上的最后提示词',
        cwd: '/srv/project',
        projectName: 'project',
        state: 'completed',
        detail: '本轮任务已完成',
        updatedAt: 2_008_000,
        completionToken: 'turn-remote-9',
        model: 'gpt-test',
      },
      {
        id: 'remote-failed',
        title: '失败任务',
        lastPrompt: '检查失败',
        cwd: '/srv/failed',
        state: 'failed',
        detail: '已停止',
        updatedAt: 2_000_000,
      },
    ],
  });
  const sessions = sessionsFromJsonData(fixture, 'dev-box');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'remote:dev-box:remote-session-123');
  assert.equal(sessions[0].lastPrompt, '服务器上的最后提示词');
  assert.equal(sessions[0].remoteHost, 'dev-box');
  assert.equal(
    sessions[0].completionKey,
    'remote:dev-box:remote-session-123:turn-remote-9',
  );
});

test('validates SSH hosts without accepting command options', () => {
  assert.equal(isValidHost('user@dev-box'), true);
  assert.equal(isValidHost('-oProxyCommand=bad'), false);
  assert.equal(isValidHost('host with spaces'), false);
});

test('discovers concrete hosts through SSH config includes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-ssh-'));
  const includeRoot = path.join(root, 'conf.d');
  await fs.mkdir(includeRoot);
  const configPath = path.join(root, 'config');
  const includedPath = path.join(includeRoot, 'servers.conf');
  const loopPath = path.join(root, 'loop.conf');
  await fs.writeFile(configPath, 'Host dev-box prod-box *.internal !disabled\nHost=equal-box\nInclude "conf.d/*.conf"\n');
  await fs.writeFile(includedPath, 'Host gpu-node user@edge # comment\nInclude ../loop.conf\n');
  await fs.writeFile(loopPath, 'Include config\n');

  assert.deepEqual(
    hostsFromSshConfig(configPath),
    ['dev-box', 'prod-box', 'equal-box', 'gpu-node', 'user@edge'],
  );
  await fs.rm(root, { recursive: true, force: true });
});
