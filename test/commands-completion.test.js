const assert = require('node:assert/strict');
const test = require('node:test');
const { sessionsByApplyingCompletionTracking } = require('../src/main/completion-tracking');
const {
  remoteResumeCommandForSession,
  resumeCommandForSession,
  sessionHasActiveWriter,
  sessionResumeBlocked,
} = require('../src/main/commands');

test('builds safe local and remote resume commands', () => {
  const local = { cwd: '/tmp/demo folder', id: 'abc-123' };
  assert.equal(
    resumeCommandForSession(local, false),
    "cd '/tmp/demo folder' && codex resume 'abc-123'",
  );
  assert.equal(
    resumeCommandForSession(local, true),
    "cd '/tmp/demo folder' && codex resume --dangerously-bypass-approvals-and-sandbox 'abc-123'",
  );

  const remote = {
    cwd: '/srv/demo folder',
    remoteSessionId: 'abc-123',
    remoteHost: 'dev-box',
  };
  const remoteCommand = remoteResumeCommandForSession(remote, false);
  assert.match(remoteCommand, /^ssh -t 'dev-box' /u);
  assert.match(remoteCommand, /PATH="\/opt\/homebrew\/bin:\/usr\/local\/bin:\$HOME\/\.local\/bin:/u);
  assert.match(remoteCommand, /codex resume/u);
  assert.match(remoteResumeCommandForSession(remote, true), /--dangerously-bypass-approvals-and-sandbox/u);
});

test('detects sessions that still have an active writer process', () => {
  assert.equal(sessionHasActiveWriter({ pid: 1234 }), true);
  assert.equal(sessionHasActiveWriter({ pid: 0 }), false);
  assert.equal(sessionHasActiveWriter({ pid: '1234' }), false);
  assert.equal(sessionHasActiveWriter({}), false);

  assert.equal(sessionResumeBlocked({ state: 'completed', pid: 1234 }), true);
  assert.equal(sessionResumeBlocked({ state: 'active' }), true);
  assert.equal(sessionResumeBlocked({ state: 'attention' }), true);
  assert.equal(sessionResumeBlocked({ state: 'completed' }), false);
});

test('tracks newly completed sessions until acknowledged', () => {
  const fixtures = [
    { id: 'attention', state: 'attention', updatedAt: 2_009_000 },
    { id: 'old', state: 'completed', updatedAt: 1_999_000, completionKey: 'old:key' },
    { id: 'new', state: 'completed', updatedAt: 2_008_000, completionKey: 'new:key' },
    { id: 'acked', state: 'completed', updatedAt: 2_007_000, completionKey: 'acked:key' },
    { id: 'failed', state: 'failed', updatedAt: 2_010_000 },
    { id: 'active', state: 'active', updatedAt: 2_006_000 },
  ];
  const tracked = sessionsByApplyingCompletionTracking(fixtures, 2_000_000, new Set(['acked:key']));
  assert.deepEqual(
    tracked.map((session) => session.state),
    ['attention', 'active', 'completed_pending', 'failed', 'completed', 'completed'],
  );
  assert.equal(tracked[2].id, 'new');

  const acknowledged = sessionsByApplyingCompletionTracking(
    fixtures,
    2_000_000,
    new Set(['acked:key', 'new:key']),
  );
  assert.equal(acknowledged.some((session) => session.state === 'completed_pending'), false);
});
