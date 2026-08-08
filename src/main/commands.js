const { spawn } = require('node:child_process');

function shellQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

function appleScriptString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function resumeCommandForSession(session, yoloEnabled = false) {
  const modeFlag = yoloEnabled ? ' --dangerously-bypass-approvals-and-sandbox' : '';
  return `cd ${shellQuote(session?.cwd)} && codex resume${modeFlag} ${shellQuote(session?.id)}`;
}

function remoteResumeCommandForSession(session, yoloEnabled = false) {
  const modeFlag = yoloEnabled ? ' --dangerously-bypass-approvals-and-sandbox' : '';
  const codexPath = 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.codex/packages/standalone/current:$PATH"';
  const remoteCommand = `cd ${shellQuote(session?.cwd)} && ${codexPath} codex resume${modeFlag} ${shellQuote(session?.remoteSessionId)}`;
  return `ssh -t ${shellQuote(session?.remoteHost)} ${shellQuote(remoteCommand)}`;
}

function sessionHasActiveWriter(session) {
  return Number.isInteger(session?.pid) && session.pid > 0;
}

function sessionResumeBlocked(session) {
  return sessionHasActiveWriter(session)
    || session?.state === 'active'
    || session?.state === 'attention';
}

function launchTerminalCommand(command) {
  const script = `tell application "Terminal"\nactivate\ndo script "${appleScriptString(command)}"\nend tell`;
  const child = spawn('/usr/bin/osascript', ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

module.exports = {
  appleScriptString,
  launchTerminalCommand,
  remoteResumeCommandForSession,
  resumeCommandForSession,
  sessionHasActiveWriter,
  sessionResumeBlocked,
  shellQuote,
};
