const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function cleanString(value, limit = 500) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/gu, ' ').trim();
  if (!clean) return null;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function isValidHost(host) {
  return typeof host === 'string'
    && host.length > 0
    && host.length <= 255
    && !host.startsWith('-')
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(host);
}

function parseRemoteRoot(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const candidate = JSON.parse(lines[index]);
        if (candidate && Array.isArray(candidate.sessions)) return candidate;
      } catch {
        // Some remote login shells print banners; keep looking for the final JSON line.
      }
    }
    return null;
  }
}

function sessionsFromJsonData(data, host) {
  const root = parseRemoteRoot(data);
  const items = Array.isArray(root) ? root : root?.sessions;
  if (!Array.isArray(items)) throw new Error('远程服务器返回了无法识别的数据');

  const sessions = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const remoteSessionId = cleanString(item.id);
    if (!remoteSessionId) continue;
    const cwd = cleanString(item.cwd) || '';
    const shortId = remoteSessionId.slice(0, 8);
    const title = cleanString(item.title);
    const lastPrompt = cleanString(item.lastPrompt)
      || title
      || `Codex 会话 ${shortId}`;
    const state = cleanString(item.state) || 'completed';
    const session = {
      ...item,
      remoteSessionId,
      id: `remote:${host}:${remoteSessionId}`,
      shortId,
      source: 'remote',
      remoteHost: host,
      cwd,
      projectName: cleanString(item.projectName) || path.basename(cwd) || '远程目录',
      lastPrompt,
      title: title || lastPrompt,
      state,
      detail: cleanString(item.detail) || '远程会话',
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    };
    delete session.completionToken;
    const completionToken = cleanString(item.completionToken);
    if (completionToken && state === 'completed') {
      session.completionKey = `remote:${host}:${remoteSessionId}:${completionToken}`;
    }
    sessions.push(session);
  }
  return sessions;
}

function tokenizeSshConfigLine(line) {
  const tokens = [];
  let current = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && !singleQuoted) {
      escaped = true;
    } else if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
    } else if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
    } else if (character === '#' && !singleQuoted && !doubleQuoted) {
      break;
    } else if (/\s/u.test(character) && !singleQuoted && !doubleQuoted) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (escaped) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function collectSshHosts(configPath, hosts, hostKeys, visitedPaths, depth) {
  if (depth > 12) return;
  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync(configPath);
  } catch {
    canonicalPath = path.resolve(configPath);
  }
  if (visitedPaths.has(canonicalPath)) return;
  visitedPaths.add(canonicalPath);

  let contents;
  try {
    contents = fs.readFileSync(canonicalPath, 'utf8');
  } catch {
    return;
  }
  const basePath = path.dirname(canonicalPath);
  for (const line of contents.split(/\r?\n/u)) {
    const tokens = tokenizeSshConfigLine(line);
    if (tokens.length === 0) continue;
    let keyword = tokens.shift();
    const equals = keyword.indexOf('=');
    if (equals >= 0) {
      const firstValue = keyword.slice(equals + 1);
      keyword = keyword.slice(0, equals);
      if (firstValue) tokens.unshift(firstValue);
    }

    if (keyword.toLowerCase() === 'host') {
      for (const host of tokens) {
        const key = host.toLowerCase();
        if (isValidHost(host) && !hostKeys.has(key)) {
          hostKeys.add(key);
          hosts.push(host);
        }
      }
    } else if (keyword.toLowerCase() === 'include') {
      for (const patternValue of tokens) {
        const expanded = expandHome(patternValue);
        const pattern = path.isAbsolute(expanded) ? expanded : path.resolve(basePath, expanded);
        let matches = [];
        try {
          matches = fs.globSync(pattern);
        } catch {
          // Invalid include patterns are ignored just like OpenSSH does for missing files.
        }
        for (const includedPath of matches) {
          try {
            if (!fs.statSync(includedPath).isFile()) continue;
          } catch {
            continue;
          }
          collectSshHosts(includedPath, hosts, hostKeys, visitedPaths, depth + 1);
        }
      }
    }
  }
}

function hostsFromSshConfig(configPath) {
  const hosts = [];
  collectSshHosts(configPath, hosts, new Set(), new Set(), 0);
  return hosts;
}

function discoverSshHosts() {
  return hostsFromSshConfig(path.join(os.homedir(), '.ssh', 'config'));
}

class RemoteScanner {
  constructor(scriptPath = path.join(__dirname, '..', 'remote', 'remote_scanner.py')) {
    this.scriptPath = scriptPath;
    this.script = null;
  }

  async scanHost(host) {
    if (!isValidHost(host)) throw new Error('SSH 主机名格式无效');
    if (!this.script) {
      try {
        this.script = await fs.promises.readFile(this.scriptPath);
      } catch {
        throw new Error('远程扫描脚本缺失');
      }
    }

    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=1',
        host,
        'python3',
        '-',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = [];
      const stderr = [];
      let outputSize = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, 25000);

      child.stdout.on('data', (chunk) => {
        outputSize += chunk.length;
        if (outputSize <= 16 * 1024 * 1024) stdout.push(chunk);
        else child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(cleanString(error.message) || '无法启动 SSH'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error('连接远程服务器超时'));
          return;
        }
        if (outputSize > 16 * 1024 * 1024) {
          reject(new Error('远程服务器返回的数据过大'));
          return;
        }
        const output = Buffer.concat(stdout);
        if (code !== 0) {
          const message = cleanString(Buffer.concat(stderr).toString('utf8'))
            || cleanString(output.toString('utf8'))
            || '无法连接远程服务器';
          reject(new Error(message));
          return;
        }
        try {
          resolve(sessionsFromJsonData(output, host));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(this.script);
    });
  }
}

module.exports = {
  RemoteScanner,
  discoverSshHosts,
  hostsFromSshConfig,
  isValidHost,
  sessionsFromJsonData,
  tokenizeSshConfigLine,
};
