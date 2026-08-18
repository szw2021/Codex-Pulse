(() => {
  const priorities = new Map([
    ['attention', 0],
    ['active', 1],
    ['completed_pending', 2],
    ['failed', 3],
  ]);

  function sessionsFrom(payload = {}) {
    return [
      ...(Array.isArray(payload.sessions) ? payload.sessions : []),
      ...(Array.isArray(payload.remoteSessions) ? payload.remoteSessions : []),
    ].filter(session => session && typeof session.id === 'string' && session.id);
  }

  function compareSessions(left, right) {
    const priority = priorities.get(left.state) - priorities.get(right.state);
    return priority || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
  }

  function diff(previous, payload = {}) {
    const sessions = sessionsFrom(payload);
    const snapshot = new Map(sessions.map(session => [session.id, session.state]));
    const relevant = sessions.filter(session => priorities.has(session.state));
    const changed = relevant.filter(session => {
      if (!(previous instanceof Map)) return false;
      return !previous.has(session.id) || previous.get(session.id) !== session.state;
    });
    changed.sort(compareSessions);
    return {
      snapshot,
      selected: changed[0] || null,
      focusCount: relevant.length,
    };
  }

  const api = Object.freeze({ diff });
  if (typeof window !== 'undefined') window.notchState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
