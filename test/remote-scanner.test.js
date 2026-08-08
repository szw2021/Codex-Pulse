const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const {
  RemoteScanner,
  hostsFromSshConfig,
  isValidHost,
  sessionsFromJsonData,
} = require('../src/main/remote-scanner');

const executeFile = promisify(execFile);

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
        pid: 4321,
        writerOwner: 'VS Code 远程终端',
        writerTty: 'ttys004',
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
  assert.equal(sessions[0].pid, 4321);
  assert.equal(sessions[0].writerOwner, 'VS Code 远程终端');
  assert.equal(sessions[0].writerTty, 'ttys004');
  assert.equal(
    sessions[0].completionKey,
    'remote:dev-box:remote-session-123:turn-remote-9',
  );
});

test('validates and forwards a remote writer termination request', async () => {
  const scanner = new RemoteScanner('/tmp/unused.py');
  let capturedArgs = null;
  scanner.runScript = async (_host, args) => {
    capturedArgs = args;
    return Buffer.from('{"ok":true,"action":"terminate"}');
  };

  const result = await scanner.manageSession('dev-box', 'terminate', 'session-1', 4321);
  assert.equal(result.ok, true);
  assert.equal(capturedArgs[0], 'terminate');
  assert.equal(Buffer.from(capturedArgs[1], 'base64url').toString('utf8'), 'session-1');
  assert.equal(Buffer.from(capturedArgs[2], 'base64url').toString('utf8'), '4321');
  await assert.rejects(
    scanner.manageSession('dev-box', 'terminate', 'session-1', 0),
    /PID/u,
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

test('remote management script renames and archives sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-remote-manage-'));
  const databasePath = path.join(root, 'state_5.sqlite');
  const scriptPath = path.join(__dirname, '..', 'src', 'remote', 'remote_scanner.py');
  const encode = value => Buffer.from(value, 'utf8').toString('base64url');
  const options = { env: { ...process.env, CODEX_HOME: root } };
  try {
    await executeFile('/usr/bin/sqlite3', [databasePath, [
      'CREATE TABLE threads (',
      'id TEXT PRIMARY KEY, title TEXT, name TEXT, archived INTEGER DEFAULT 0, archived_at INTEGER);',
      "INSERT INTO threads (id, title) VALUES ('remote-1', '远程标题');",
    ].join(' ')]);

    const renamed = await executeFile('python3', [
      scriptPath, 'rename', encode('remote-1'), encode('远程新名称'),
    ], options);
    assert.equal(JSON.parse(renamed.stdout).ok, true);
    let result = await executeFile('/usr/bin/sqlite3', [
      '-json', databasePath,
      "SELECT name, archived FROM threads WHERE id = 'remote-1';",
    ]);
    assert.deepEqual(JSON.parse(result.stdout), [{ name: '远程新名称', archived: 0 }]);

    const archived = await executeFile('python3', [
      scriptPath, 'archive', encode('remote-1'), encode(''),
    ], options);
    assert.equal(JSON.parse(archived.stdout).ok, true);
    result = await executeFile('/usr/bin/sqlite3', [
      '-json', databasePath,
      "SELECT archived, archived_at > 0 AS has_archived_at FROM threads WHERE id = 'remote-1';",
    ]);
    assert.deepEqual(JSON.parse(result.stdout), [{ archived: 1, has_archived_at: 1 }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote management script only terminates the matching temporary writer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-remote-terminate-'));
  const sessionsRoot = path.join(root, 'sessions', '2026', '08', '08');
  const rolloutPath = path.join(sessionsRoot, 'rollout-temporary-session.jsonl');
  const readyPath = path.join(root, 'writer-ready');
  const writerPath = path.join(root, 'codex-test-writer.py');
  const databasePath = path.join(root, 'state_5.sqlite');
  const scriptPath = path.join(__dirname, '..', 'src', 'remote', 'remote_scanner.py');
  const encode = value => Buffer.from(String(value), 'utf8').toString('base64url');
  const options = { env: { ...process.env, CODEX_HOME: root } };
  let writer = null;
  try {
    await fs.mkdir(sessionsRoot, { recursive: true });
    await fs.writeFile(rolloutPath, '{"type":"session_meta"}\n');
    await fs.writeFile(writerPath, [
      'import pathlib',
      'import sys',
      'import time',
      'with open(sys.argv[1], "rb"):',
      '    pathlib.Path(sys.argv[2]).touch()',
      '    while True:',
      '        time.sleep(1)',
      '',
    ].join('\n'));
    await executeFile('/usr/bin/sqlite3', [databasePath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);',
      `INSERT INTO threads (id, rollout_path) VALUES ('temporary-session', '${rolloutPath.replaceAll("'", "''")}');`,
    ].join(' ')]);

    writer = spawn('python3', [writerPath, rolloutPath, readyPath], { stdio: 'ignore' });
    const writerClosed = once(writer, 'close');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fs.access(readyPath);
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await fs.access(readyPath);

    const terminated = await executeFile('python3', [
      scriptPath, 'terminate', encode('temporary-session'), encode(writer.pid),
    ], options);
    const result = JSON.parse(terminated.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'terminate');
    assert.equal(result.pid, writer.pid);
    await writerClosed;
    writer = null;
  } finally {
    if (writer && writer.exitCode === null) writer.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
  }
});
