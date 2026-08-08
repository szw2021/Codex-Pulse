const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const {
  CodexScanner,
  detectStateInData,
  latestUserPromptAtPath,
} = require('../src/main/codex-scanner');

const NOW = 2_000_000_000_000;
const executeFile = promisify(execFile);

function jsonLine(outerType, payload, secondsAgo) {
  return JSON.stringify({
    timestamp: new Date(NOW - secondsAgo * 1000).toISOString(),
    type: outerType,
    payload,
  });
}

function event(type, secondsAgo) {
  return jsonLine('event_msg', { type }, secondsAgo);
}

function userMessage(message, secondsAgo) {
  return jsonLine('event_msg', { type: 'user_message', message }, secondsAgo);
}

function userResponseMessage(message, secondsAgo) {
  return jsonLine('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: message }],
  }, secondsAgo);
}

function toolCall(name, secondsAgo) {
  return jsonLine('response_item', {
    type: 'function_call',
    call_id: 'call-1',
    name,
  }, secondsAgo);
}

function toolOutput(secondsAgo) {
  return jsonLine('response_item', {
    type: 'function_call_output',
    call_id: 'call-1',
    output: 'ok',
  }, secondsAgo);
}

function detect(lines, approvalMode, processInfo, modifiedAgo) {
  return detectStateInData(lines.join('\n'), {
    approvalMode,
    processInfo,
    fileModifiedAt: NOW - modifiedAgo * 1000,
    now: NOW,
  });
}

test('detects Codex turn states and approval waits', async (t) => {
  const idleProcess = { pid: 7, hasWorkingChild: false };
  const workingProcess = { pid: 7, hasWorkingChild: true };
  const cases = [
    ['active', [event('task_started', 5)], 'never', idleProcess, 5, 'active'],
    ['completed', [event('task_started', 10), event('task_complete', 1)], 'on-request', idleProcess, 1, 'completed'],
    ['aborted', [event('task_started', 10), event('turn_aborted', 1)], 'on-request', idleProcess, 1, 'failed'],
    ['approval', [event('task_started', 10), toolCall('exec_command', 5)], 'on-request', idleProcess, 5, 'attention'],
    ['running command', [event('task_started', 10), toolCall('exec_command', 5)], 'on-request', workingProcess, 5, 'active'],
    ['request user input', [event('task_started', 10), toolCall('request_user_input', 5)], 'never', idleProcess, 5, 'attention'],
    ['unexpected stop', [event('task_started', 30)], 'never', null, 30, 'failed'],
    ['completed tool call', [event('task_started', 10), toolCall('exec_command', 5), toolOutput(4)], 'on-request', idleProcess, 4, 'active'],
    ['previous turn tool ignored', [toolCall('exec_command', 20), event('task_started', 5)], 'on-request', idleProcess, 5, 'active'],
    ['approval grace period', [event('task_started', 2), toolCall('exec_command', 0.5)], 'on-request', idleProcess, 0.5, 'active'],
    ['error', [event('task_started', 10), event('error', 1)], 'never', idleProcess, 1, 'failed'],
  ];

  for (const [name, lines, approvalMode, processInfo, modifiedAgo, expected] of cases) {
    await t.test(name, () => {
      assert.equal(detect(lines, approvalMode, processInfo, modifiedAgo).state, expected);
    });
  }
});

test('extracts prompts and stable completion identities', () => {
  const completed = detect([
    event('task_started', 10),
    userMessage('  第一行\n第二行  ', 9),
    event('task_complete', 1),
  ], 'never', { pid: 7, hasWorkingChild: false }, 1);
  assert.equal(completed.lastPrompt, '第一行 第二行');

  const completion = detect([
    event('task_started', 10),
    jsonLine('event_msg', { type: 'task_complete', turn_id: 'turn-complete-123' }, 1),
  ], 'never', { pid: 7, hasWorkingChild: false }, 1);
  assert.equal(completion.completionToken, 'turn-complete-123');

  const latest = detect([
    event('task_started', 20),
    userMessage('旧提示词', 19),
    event('task_complete', 15),
    event('task_started', 5),
    userResponseMessage('新版记录里的最新提示词', 4),
  ], 'never', { pid: 7, hasWorkingChild: false }, 4);
  assert.equal(latest.lastPrompt, '新版记录里的最新提示词');
});

test('finds prompts across chunks and incrementally', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-prompt-'));
  const fixturePath = path.join(root, 'session.jsonl');
  const filler = `${jsonLine('event_msg', { type: 'token_count' }, 0)}\n`;
  let fixture = `${userMessage('跨块旧提示词', 20)}\n`;
  while (Buffer.byteLength(fixture) < 700_000) fixture += filler;
  await fs.writeFile(fixturePath, fixture);

  assert.equal(await latestUserPromptAtPath(fixturePath, 0), '跨块旧提示词');
  const previousSize = Buffer.byteLength(fixture);
  await fs.appendFile(fixturePath, `${userResponseMessage('增量新版最新提示词', 1)}\n${filler}`);
  assert.equal(await latestUserPromptAtPath(fixturePath, previousSize), '增量新版最新提示词');
  await fs.rm(root, { recursive: true, force: true });
});

test('falls back to a temporary SQLite snapshot when direct reads fail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-db-test-'));
  const databasePath = path.join(root, 'state_5.sqlite');
  await fs.writeFile(databasePath, 'database');
  await fs.writeFile(`${databasePath}-wal`, 'wal');
  const scanner = new CodexScanner(root);
  let snapshotRoot = null;
  let directAttempts = 0;
  scanner.queryJsonDirect = async (candidatePath, _sql, options) => {
    if (candidatePath === databasePath) {
      directAttempts += 1;
      throw new Error('direct read failed');
    }
    snapshotRoot = path.dirname(candidatePath);
    assert.equal(options.readOnly, false);
    assert.equal(await fs.readFile(candidatePath, 'utf8'), 'database');
    assert.equal(await fs.readFile(`${candidatePath}-wal`, 'utf8'), 'wal');
    return [{ ok: 1 }];
  };

  assert.deepEqual(await scanner.queryJson(databasePath, 'SELECT 1'), [{ ok: 1 }]);
  assert.equal(directAttempts, 2);
  await assert.rejects(fs.access(snapshotRoot));
  await fs.rm(root, { recursive: true, force: true });
});

test('renames and archives local sessions through the Codex database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-manage-'));
  const databasePath = path.join(root, 'state_5.sqlite');
  try {
    await executeFile('/usr/bin/sqlite3', [databasePath, [
      'CREATE TABLE threads (',
      'id TEXT PRIMARY KEY, title TEXT, name TEXT, archived INTEGER DEFAULT 0, archived_at INTEGER);',
      "INSERT INTO threads (id, title) VALUES ('session-1', '原始标题');",
    ].join(' ')]);
    const scanner = new CodexScanner(root);

    assert.equal(await scanner.renameSession('session-1', '新的会话名称'), '新的会话名称');
    let result = await executeFile('/usr/bin/sqlite3', [
      '-json', databasePath,
      "SELECT name, archived FROM threads WHERE id = 'session-1';",
    ]);
    assert.deepEqual(JSON.parse(result.stdout), [{ name: '新的会话名称', archived: 0 }]);

    await scanner.archiveSession('session-1');
    result = await executeFile('/usr/bin/sqlite3', [
      '-json', databasePath,
      "SELECT archived, archived_at > 0 AS has_archived_at FROM threads WHERE id = 'session-1';",
    ]);
    assert.deepEqual(JSON.parse(result.stdout), [{ archived: 1, has_archived_at: 1 }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scans the installed Codex database when available', { timeout: 60_000 }, async (t) => {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    await fs.access(path.join(codexHome, 'state_5.sqlite'));
  } catch {
    t.skip('No local Codex database is available');
    return;
  }

  const scanner = new CodexScanner(codexHome);
  const sessions = await scanner.scanSessions();
  const validStates = new Set(['active', 'attention', 'failed', 'completed']);
  for (const session of sessions) {
    assert.equal(session.source, 'cli');
    assert.ok(validStates.has(session.state));
    assert.ok(session.lastPrompt);
  }
  const cachedSessions = await scanner.scanSessions();
  assert.equal(cachedSessions.length, sessions.length);
});
