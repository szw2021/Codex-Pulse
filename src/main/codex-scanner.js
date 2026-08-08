const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_TAIL_BYTES = 512 * 1024;
const PROMPT_CHUNK_BYTES = 256 * 1024;
const SQLITE3_PATH = process.env.CODEX_PULSE_SQLITE3 || '/usr/bin/sqlite3';
const DATABASE_READ_RETRIES = 2;
const SNAPSHOT_RETRIES = 3;

function cleanString(value, limit = 500) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/gu, ' ').trim();
  if (!clean) return null;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function cleanTitle(value, fallbackId) {
  const clean = cleanString(value, 100);
  if (!clean || clean === fallbackId) return `Codex 会话 ${fallbackId.slice(0, 8)}`;
  return clean;
}

function sqlText(value) {
  return `CAST(X'${Buffer.from(String(value), 'utf8').toString('hex')}' AS TEXT)`;
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseJsonLine(value) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value);
  } catch {
    return null;
  }
}

function promptFromRecord(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (record.type === 'event_msg' && payload.type === 'user_message') {
    return cleanString(payload.message);
  }
  if (record.type !== 'response_item'
    || payload.type !== 'message'
    || payload.role !== 'user') return null;
  if (typeof payload.content === 'string') return cleanString(payload.content);
  if (!Array.isArray(payload.content)) return null;
  const text = payload.content
    .filter((item) => item
      && (item.type === 'input_text' || item.type === 'text')
      && typeof item.text === 'string')
    .map((item) => item.text)
    .join(' ');
  return cleanString(text);
}

function attentionDetail(toolName) {
  const name = String(toolName || '').toLowerCase();
  if (name.includes('request_user_input')) return 'Codex 正在等待你的选择';
  if (name.includes('permission')) return 'Codex 正在请求权限';
  if (name.includes('apply_patch') || name.includes('write')) return '文件修改等待确认';
  if (name.includes('mcp')) return '外部工具调用等待确认';
  return '命令执行等待确认';
}

function needsAttention(call, approvalMode, hasWorkingChild, now) {
  const name = String(call?.name || '').toLowerCase();
  if (call?.startedAt && now - call.startedAt < 1200) return false;
  if (name.includes('request_user_input') || name.includes('requestpermission')) return true;
  if (String(approvalMode).toLowerCase() === 'never' || hasWorkingChild) return false;
  return ['exec', 'shell', 'apply_patch', 'write', 'permission', 'mcp']
    .some((needle) => name.includes(needle));
}

function detectStateInData(data, {
  approvalMode = 'never',
  processInfo = null,
  fileModifiedAt = Date.now(),
  now = Date.now(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const modifiedAtMs = fileModifiedAt instanceof Date
    ? fileModifiedAt.getTime()
    : Number(fileModifiedAt);
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  if (!text) {
    return {
      state: processInfo ? 'active' : 'failed',
      detail: processInfo ? 'Codex 正在运行' : '会话记录不可读',
      updatedAt: Number.isFinite(modifiedAtMs) ? modifiedAtMs : nowMs,
    };
  }

  const lines = text.split(/\r?\n/u);
  let unfinished = false;
  let foundBoundary = false;
  let terminalState = null;
  let terminalDetail = null;
  let completionToken = null;
  let lastEventAt = null;
  let latestCall = null;
  let lastPrompt = null;
  const resolvedCalls = new Set();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]) continue;
    const root = parseJsonLine(lines[index]);
    const payload = root?.payload;
    if (!root || !payload || typeof payload !== 'object') continue;

    const timestamp = parseTimestamp(root.timestamp);
    if (timestamp !== null && lastEventAt === null) lastEventAt = timestamp;
    const outerType = root.type;
    const payloadType = payload.type;

    if (!lastPrompt) lastPrompt = promptFromRecord(root);

    if (outerType === 'event_msg') {
      if (!foundBoundary && payloadType === 'task_started') {
        unfinished = true;
        foundBoundary = true;
      } else if (!foundBoundary && payloadType === 'task_complete') {
        terminalState = 'completed';
        terminalDetail = '本轮任务已完成';
        completionToken = cleanString(payload.turn_id)
          || cleanString(root.timestamp)
          || (payload.completed_at == null ? null : String(payload.completed_at));
        foundBoundary = true;
      } else if (!foundBoundary && payloadType === 'turn_aborted') {
        terminalState = 'failed';
        terminalDetail = '任务已中止';
        foundBoundary = true;
      } else if (!foundBoundary && payloadType === 'error') {
        terminalState = 'failed';
        const rawError = typeof payload.error === 'object'
          ? payload.error?.message
          : payload.message || payload.error;
        terminalDetail = cleanString(rawError, 160) || 'Codex 执行出错';
        foundBoundary = true;
      }
    }

    if (foundBoundary && lastPrompt) break;
    if (foundBoundary || outerType !== 'response_item') continue;

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      if (typeof payload.call_id === 'string') resolvedCalls.add(payload.call_id);
    } else if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const callId = payload.call_id || payload.id;
      if (!latestCall && typeof callId === 'string' && !resolvedCalls.has(callId)) {
        latestCall = {
          name: typeof payload.name === 'string' ? payload.name : 'tool',
          startedAt: timestamp,
        };
      }
    }
  }

  const bestUpdatedAt = lastEventAt
    ?? (Number.isFinite(modifiedAtMs) ? modifiedAtMs : nowMs);
  if (!foundBoundary && processInfo && latestCall) unfinished = true;

  if (unfinished) {
    const hasWorkingChild = Boolean(processInfo?.hasWorkingChild);
    if (latestCall && needsAttention(latestCall, approvalMode, hasWorkingChild, nowMs)) {
      return {
        state: 'attention',
        detail: attentionDetail(latestCall.name),
        updatedAt: latestCall.startedAt || bestUpdatedAt,
        ...(lastPrompt ? { lastPrompt } : {}),
      };
    }

    const modifiedAgo = Number.isFinite(modifiedAtMs)
      ? (nowMs - modifiedAtMs) / 1000
      : Number.POSITIVE_INFINITY;
    if (processInfo || modifiedAgo < 12) {
      return {
        state: 'active',
        detail: hasWorkingChild ? '正在执行命令' : 'Codex 正在思考与执行',
        updatedAt: bestUpdatedAt,
        ...(lastPrompt ? { lastPrompt } : {}),
      };
    }
    return {
      state: 'failed',
      detail: '会话意外停止，没有完成事件',
      updatedAt: bestUpdatedAt,
      ...(lastPrompt ? { lastPrompt } : {}),
    };
  }

  if (terminalState) {
    return {
      state: terminalState,
      detail: terminalDetail || '',
      updatedAt: bestUpdatedAt,
      ...(lastPrompt ? { lastPrompt } : {}),
      ...(completionToken ? { completionToken } : {}),
    };
  }
  if (processInfo) {
    return {
      state: 'active',
      detail: 'Codex 会话已启动',
      updatedAt: bestUpdatedAt,
      ...(lastPrompt ? { lastPrompt } : {}),
    };
  }
  return {
    state: 'completed',
    detail: '会话当前空闲',
    updatedAt: bestUpdatedAt,
    ...(lastPrompt ? { lastPrompt } : {}),
  };
}

function executeFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15000,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout || '');
    });
  });
}

async function runOptionalTool(file, args) {
  try {
    return await executeFile(file, args);
  } catch (error) {
    return error.stdout || '';
  }
}

function processTreeFromOutput(output) {
  const tree = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    if (!tree.has(parent)) tree.set(parent, []);
    tree.get(parent).push({ pid, command: match[3] });
  }
  return tree;
}

function hasWorkingDescendant(processId, tree) {
  const queue = [...(tree.get(processId) || [])];
  const visited = new Set();
  while (queue.length > 0) {
    const child = queue.pop();
    if (visited.has(child.pid)) continue;
    visited.add(child.pid);
    const command = child.command.toLowerCase();
    const lastComponent = path.basename(command);
    const isHelper = command.includes('codex-code-mode-host')
      || lastComponent === 'codex'
      || lastComponent === 'node';
    if (!isHelper) return true;
    queue.push(...(tree.get(child.pid) || []));
  }
  return false;
}

async function activeSessionProcessesAtRoot(sessionsRoot) {
  const [lsofOutput, psOutput] = await Promise.all([
    runOptionalTool('/usr/sbin/lsof', ['-F', 'pn', '+D', sessionsRoot]),
    runOptionalTool('/bin/ps', ['-axo', 'pid=,ppid=,comm=']),
  ]);
  const pathPids = new Map();
  let currentPid = null;
  for (const line of lsofOutput.split(/\r?\n/u)) {
    if (line.startsWith('p')) currentPid = Number(line.slice(1));
    if (line.startsWith('n') && line.endsWith('.jsonl') && currentPid) {
      pathPids.set(path.resolve(line.slice(1)), currentPid);
    }
  }

  const tree = processTreeFromOutput(psOutput);
  return new Map([...pathPids].map(([rolloutPath, pid]) => [rolloutPath, {
    pid,
    hasWorkingChild: hasWorkingDescendant(pid, tree),
  }]));
}

async function tailDataAtPath(filePath, maximumBytes = MAX_TAIL_BYTES) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maximumBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    if (start === 0) return buffer;
    const newline = buffer.indexOf(0x0a);
    return newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0);
  } finally {
    await handle.close();
  }
}

async function latestUserPromptAtPath(filePath, lowerBound = 0) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    const boundary = lowerBound > size ? 0 : Math.max(0, lowerBound);
    let position = size;
    let carry = Buffer.alloc(0);

    while (position > boundary) {
      const start = Math.max(boundary, position - PROMPT_CHUNK_BYTES);
      const chunk = Buffer.alloc(position - start);
      await handle.read(chunk, 0, chunk.length, start);
      const combined = Buffer.concat([chunk, carry]);
      let lineEnd = combined.length;
      while (lineEnd > 0) {
        const newline = combined.lastIndexOf(0x0a, lineEnd - 1);
        if (newline < 0) break;
        if (lineEnd > newline + 1) {
          const prompt = promptFromRecord(parseJsonLine(combined.subarray(newline + 1, lineEnd)));
          if (prompt) return prompt;
        }
        lineEnd = newline;
      }
      carry = Buffer.from(combined.subarray(0, lineEnd));
      position = start;
    }
    return carry.length > 0 ? promptFromRecord(parseJsonLine(carry)) : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fileFingerprint(filePath) {
  try {
    const attributes = await fs.stat(filePath);
    return `${attributes.ino}:${attributes.size}:${attributes.mtimeMs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function copyDatabaseSnapshot(databasePath, snapshotPath) {
  const walPath = `${databasePath}-wal`;
  const snapshotWalPath = `${snapshotPath}-wal`;
  const before = await Promise.all([
    fileFingerprint(databasePath),
    fileFingerprint(walPath),
  ]);
  await fs.copyFile(databasePath, snapshotPath);
  if (before[1]) await fs.copyFile(walPath, snapshotWalPath);
  const after = await Promise.all([
    fileFingerprint(databasePath),
    fileFingerprint(walPath),
  ]);
  if (before[0] !== after[0] || before[1] !== after[1]) {
    const error = new Error('Codex 状态数据库在创建快照时发生变化');
    error.code = 'EBUSY';
    throw error;
  }
}

class CodexScanner {
  constructor(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
    this.codexHome = path.resolve(expandHome(codexHome));
    this.stateCache = new Map();
    this.promptCache = new Map();
    this.columns = null;
  }

  async queryJson(databasePath, sql) {
    let directError = null;
    for (let attempt = 0; attempt < DATABASE_READ_RETRIES; attempt += 1) {
      try {
        return await this.queryJsonDirect(databasePath, sql);
      } catch (error) {
        directError = error;
        if (attempt + 1 < DATABASE_READ_RETRIES) await delay(50);
      }
    }

    let snapshotError = directError;
    for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt += 1) {
      const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pulse-db-'));
      const snapshotPath = path.join(snapshotRoot, path.basename(databasePath));
      try {
        await copyDatabaseSnapshot(databasePath, snapshotPath);
        return await this.queryJsonDirect(snapshotPath, sql, { readOnly: false });
      } catch (error) {
        snapshotError = error;
      } finally {
        await fs.rm(snapshotRoot, { recursive: true, force: true });
      }
      if (attempt + 1 < SNAPSHOT_RETRIES) await delay(50);
    }
    snapshotError.cause = directError;
    throw snapshotError;
  }

  async queryJsonDirect(databasePath, sql, { readOnly = true } = {}) {
    const args = [
      '-cmd', '.timeout 1000',
    ];
    if (readOnly) args.unshift('-readonly');
    else args.push('-cmd', 'PRAGMA query_only=ON;');
    args.push(
      '-json',
      databasePath,
      sql,
    );
    const output = await executeFile(SQLITE3_PATH, args);
    if (!output.trim()) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  }

  async writeJson(databasePath, sql) {
    const output = await executeFile(SQLITE3_PATH, [
      '-cmd', '.timeout 2000',
      '-json',
      databasePath,
      sql,
    ]);
    if (!output.trim()) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  }

  async renameSession(sessionId, value) {
    const id = cleanString(sessionId, 200);
    const name = cleanString(value, 100);
    if (!id || !name) throw new Error('会话名称不能为空');
    const databasePath = path.join(this.codexHome, 'state_5.sqlite');
    const columns = await this.threadColumns(databasePath);
    const column = columns.has('name') ? 'name' : columns.has('title') ? 'title' : null;
    if (!column) throw new Error('当前 Codex 数据库不支持会话重命名');
    const rows = await this.writeJson(databasePath, [
      `UPDATE threads SET "${column}" = ${sqlText(name)} WHERE "id" = ${sqlText(id)};`,
      'SELECT changes() AS changed;',
    ].join(' '));
    if (Number(rows.at(-1)?.changed) !== 1) throw new Error('未找到要重命名的会话');
    return name;
  }

  async archiveSession(sessionId) {
    const id = cleanString(sessionId, 200);
    if (!id) throw new Error('会话 ID 无效');
    const databasePath = path.join(this.codexHome, 'state_5.sqlite');
    const columns = await this.threadColumns(databasePath);
    if (!columns.has('archived')) throw new Error('当前 Codex 数据库不支持删除会话');
    const assignments = ['"archived" = 1'];
    if (columns.has('archived_at')) assignments.push(`"archived_at" = ${Math.floor(Date.now() / 1000)}`);
    const rows = await this.writeJson(databasePath, [
      `UPDATE threads SET ${assignments.join(', ')} WHERE "id" = ${sqlText(id)};`,
      'SELECT changes() AS changed;',
    ].join(' '));
    if (Number(rows.at(-1)?.changed) !== 1) throw new Error('未找到要删除的会话');
  }

  async threadColumns(databasePath) {
    if (this.columns) return this.columns;
    const rows = await this.queryJson(databasePath, 'PRAGMA table_info(threads);');
    this.columns = new Set(rows.map((row) => row.name).filter((name) => typeof name === 'string'));
    if (this.columns.size === 0) throw new Error('Codex 状态数据库中缺少 threads 表');
    return this.columns;
  }

  async threadRows(databasePath) {
    const columns = await this.threadColumns(databasePath);
    const column = (name, fallback) => (columns.has(name) ? `"${name}"` : fallback);
    const firstText = (names, fallback) => {
      const values = names.filter((name) => columns.has(name)).map((name) => `NULLIF("${name}", '')`);
      values.push(fallback);
      return `COALESCE(${values.join(', ')})`;
    };
    const conditions = [];
    if (columns.has('archived')) conditions.push('"archived" = 0');
    if (columns.has('source')) conditions.push('"source" = \'cli\'');
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = [
      'SELECT "id", "rollout_path",',
      `${column('updated_at', '0')} AS updated_at,`,
      `${column('source', "'cli'")} AS source,`,
      `${column('cwd', "''")} AS cwd,`,
      `${firstText(['name', 'title', 'preview'], '"id"')} AS title,`,
      `${column('approval_mode', "'never'")} AS approval_mode,`,
      `${column('model', "''")} AS model,`,
      `${firstText(['preview', 'first_user_message', 'title'], '"id"')} AS fallback_prompt`,
      `FROM threads${where} ORDER BY updated_at DESC LIMIT 100;`,
    ].join(' ');
    return this.queryJson(databasePath, sql);
  }

  async scanSessions() {
    const databasePath = path.join(this.codexHome, 'state_5.sqlite');
    const sessionsRoot = path.join(this.codexHome, 'sessions');
    let processes;
    let rows;
    try {
      [processes, rows] = await Promise.all([
        activeSessionProcessesAtRoot(sessionsRoot),
        this.threadRows(databasePath),
      ]);
    } catch (error) {
      throw new Error(`无法打开或读取 Codex 状态数据库：${cleanString(error.stderr || error.message, 300) || '未知错误'}`);
    }

    const sessions = [];
    const scannedPaths = new Set();
    for (const row of rows) {
      const sessionId = typeof row.id === 'string' ? row.id : String(row.id || '');
      const rawRolloutPath = typeof row.rollout_path === 'string' ? row.rollout_path : '';
      if (!sessionId || !rawRolloutPath) continue;
      const rolloutPath = path.resolve(expandHome(rawRolloutPath));

      let attributes;
      try {
        attributes = await fs.stat(rolloutPath);
      } catch {
        continue;
      }
      if (!attributes.isFile()) continue;
      scannedPaths.add(rolloutPath);

      const processInfo = processes.get(rolloutPath) || null;
      const approvalMode = typeof row.approval_mode === 'string' ? row.approval_mode : 'never';
      const processKey = processInfo
        ? `${processInfo.pid}:${processInfo.hasWorkingChild ? 1 : 0}`
        : 'none';
      const cached = this.stateCache.get(rolloutPath);
      const cacheMatches = cached
        && cached.fileSize === attributes.size
        && cached.modifiedAt === attributes.mtimeMs
        && cached.approvalMode === approvalMode
        && cached.processKey === processKey;

      let state = cacheMatches ? cached.result : null;
      if (!state) {
        let tail = Buffer.alloc(0);
        try {
          tail = await tailDataAtPath(rolloutPath);
        } catch {
          // The fallback below preserves the process-derived state.
        }
        state = tail.length > 0
          ? detectStateInData(tail, {
            approvalMode,
            processInfo,
            fileModifiedAt: attributes.mtimeMs,
            now: Date.now(),
          })
          : {
            state: processInfo ? 'active' : 'failed',
            detail: processInfo ? 'Codex 正在运行' : '会话记录不可读',
            updatedAt: attributes.mtimeMs,
          };

        if (state.state === 'completed' || state.state === 'failed') {
          this.stateCache.set(rolloutPath, {
            fileSize: attributes.size,
            modifiedAt: attributes.mtimeMs,
            approvalMode,
            processKey,
            result: state,
          });
        } else {
          this.stateCache.delete(rolloutPath);
        }
      }

      let lastPrompt = cleanString(state.lastPrompt);
      const promptCache = this.promptCache.get(rolloutPath);
      const cachedPrompt = cleanString(promptCache?.prompt);
      if (!lastPrompt) {
        const lowerBound = promptCache && attributes.size >= promptCache.fileSize
          ? promptCache.fileSize
          : 0;
        if (attributes.size > lowerBound || !cachedPrompt) {
          lastPrompt = await latestUserPromptAtPath(rolloutPath, lowerBound);
        }
        if (!lastPrompt) lastPrompt = cachedPrompt;
      }

      const title = cleanTitle(typeof row.title === 'string' ? row.title : sessionId, sessionId);
      if (!lastPrompt) lastPrompt = cleanString(row.fallback_prompt) || title;
      this.promptCache.set(rolloutPath, { fileSize: attributes.size, prompt: lastPrompt });

      const cwd = typeof row.cwd === 'string' ? row.cwd : '';
      const projectName = path.basename(cwd) || cwd;
      const fallbackUpdatedAt = parseTimestamp(row.updated_at) || attributes.mtimeMs;
      const updatedAt = Number.isFinite(Number(state.updatedAt))
        ? Number(state.updatedAt)
        : fallbackUpdatedAt;
      const session = {
        id: sessionId,
        shortId: sessionId.slice(0, 8),
        title,
        lastPrompt,
        cwd,
        projectName,
        source: typeof row.source === 'string' ? row.source : 'cli',
        rolloutPath,
        state: state.state || 'completed',
        detail: state.detail || '',
        updatedAt,
      };
      if (typeof state.completionToken === 'string' && state.completionToken) {
        session.completionKey = `${sessionId}:${state.completionToken}`;
      }
      if (typeof row.model === 'string' && row.model) session.model = row.model;
      if (processInfo?.pid) session.pid = processInfo.pid;
      sessions.push(session);
    }

    for (const rolloutPath of this.stateCache.keys()) {
      if (!scannedPaths.has(rolloutPath)) this.stateCache.delete(rolloutPath);
    }
    for (const rolloutPath of this.promptCache.keys()) {
      if (!scannedPaths.has(rolloutPath)) this.promptCache.delete(rolloutPath);
    }

    const priority = new Map([['active', 0], ['completed', 1], ['attention', 2], ['failed', 3]]);
    return sessions.sort((left, right) => {
      const difference = (priority.get(left.state) ?? 99) - (priority.get(right.state) ?? 99);
      return difference || right.updatedAt - left.updatedAt;
    });
  }
}

module.exports = {
  CodexScanner,
  activeSessionProcessesAtRoot,
  cleanString,
  detectStateInData,
  latestUserPromptAtPath,
};
