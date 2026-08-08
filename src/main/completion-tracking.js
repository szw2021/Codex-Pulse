const STATE_PRIORITY = new Map([
  ['attention', 0],
  ['active', 1],
  ['completed_pending', 2],
  ['failed', 3],
  ['completed', 4],
]);

function sessionsByApplyingCompletionTracking(
  sessions,
  trackingStartedAt,
  acknowledgedCompletions = new Set(),
) {
  const acknowledged = acknowledgedCompletions instanceof Set
    ? acknowledgedCompletions
    : new Set(acknowledgedCompletions);
  const result = sessions.map((session) => {
    const display = { ...session };
    const isNewCompletion = session.state === 'completed'
      && typeof session.completionKey === 'string'
      && session.completionKey.length > 0
      && Number(session.updatedAt) > Number(trackingStartedAt)
      && !acknowledged.has(session.completionKey);
    if (isNewCompletion) {
      display.state = 'completed_pending';
      display.detail = '任务已完成，等待你确认';
    }
    return display;
  });

  return result.sort((left, right) => {
    const priorityDifference = (STATE_PRIORITY.get(left.state) ?? 99)
      - (STATE_PRIORITY.get(right.state) ?? 99);
    return priorityDifference || Number(right.updatedAt) - Number(left.updatedAt);
  });
}

module.exports = { sessionsByApplyingCompletionTracking };
