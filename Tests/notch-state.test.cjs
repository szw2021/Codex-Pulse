const test = require('node:test');
const assert = require('node:assert/strict');

const { diff } = require('../src/renderer/notch-state.js');

const payload = sessions => ({ sessions, remoteSessions: [] });
const session = (id, state, updatedAt = 1) => ({ id, state, updatedAt });

test('initial payload only creates a baseline', () => {
  const result = diff(null, payload([session('one', 'active')]));
  assert.equal(result.selected, null);
  assert.equal(result.snapshot.get('one'), 'active');
});

test('selects the highest priority changed session', () => {
  const previous = new Map([
    ['active-session', 'completed'],
    ['attention-session', 'active'],
  ]);
  const result = diff(previous, payload([
    session('active-session', 'active', 20),
    session('attention-session', 'attention', 10),
  ]));
  assert.equal(result.selected.id, 'attention-session');
  assert.equal(result.focusCount, 2);
});

test('does not notify for unchanged state or acknowledgement', () => {
  const previous = new Map([
    ['running', 'active'],
    ['done', 'completed_pending'],
  ]);
  const result = diff(previous, payload([
    session('running', 'active', 20),
    session('done', 'completed', 30),
  ]));
  assert.equal(result.selected, null);
  assert.equal(result.focusCount, 1);
});

test('treats a new relevant session as a state change', () => {
  const result = diff(new Map(), payload([session('new', 'failed')]));
  assert.equal(result.selected.id, 'new');
});
