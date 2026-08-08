import atexit
import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time


def clean(value, limit=500):
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    if not value:
        return None
    return value[:limit] + ("…" if len(value) > limit else "")


def parse_time(value):
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def json_line(raw):
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None


def prompt_from_record(record):
    if not isinstance(record, dict):
        return None
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    if record.get("type") == "event_msg" and payload.get("type") == "user_message":
        return clean(payload.get("message"))
    if (record.get("type") != "response_item"
            or payload.get("type") != "message"
            or payload.get("role") != "user"):
        return None
    content = payload.get("content")
    if isinstance(content, str):
        return clean(content)
    if not isinstance(content, list):
        return None
    text = " ".join(
        item.get("text", "")
        for item in content
        if isinstance(item, dict)
        and item.get("type") in ("input_text", "text")
        and isinstance(item.get("text"), str)
    )
    return clean(text)


def latest_prompt(path):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            position = handle.tell()
            carry = b""
            while position > 0:
                start = max(0, position - 262144)
                handle.seek(start)
                block = handle.read(position - start) + carry
                parts = block.split(b"\n")
                carry = parts[0]
                for raw in reversed(parts[1:]):
                    prompt = prompt_from_record(json_line(raw))
                    if prompt:
                        return prompt
                position = start
            return prompt_from_record(json_line(carry)) if carry else None
    except OSError:
        return None


def process_snapshot(sessions_root):
    active_paths = {}
    children = {}
    commands = {}
    proc_root = "/proc"
    if not os.path.isdir(proc_root):
        try:
            output = subprocess.run(
                ["lsof", "-F", "pn", "+D", sessions_root],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5
            ).stdout
            pid = None
            for line in output.splitlines():
                if line.startswith("p"):
                    pid = int(line[1:])
                elif line.startswith("n") and line.endswith(".jsonl") and pid:
                    active_paths[os.path.realpath(line[1:])] = pid
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        return active_paths, children, commands
    try:
        process_ids = [name for name in os.listdir(proc_root) if name.isdigit()]
    except OSError:
        return active_paths, children, commands
    for name in process_ids:
        pid = int(name)
        try:
            with open(os.path.join(proc_root, name, "stat"), "r", encoding="utf-8") as handle:
                stat = handle.read()
            close = stat.rfind(")")
            fields = stat[close + 2:].split()
            parent = int(fields[1])
            command = stat[stat.find("(") + 1:close]
            children.setdefault(parent, []).append(pid)
            commands[pid] = command
        except (OSError, ValueError, IndexError):
            pass
        fd_root = os.path.join(proc_root, name, "fd")
        try:
            for fd in os.listdir(fd_root):
                try:
                    target = os.path.realpath(os.path.join(fd_root, fd))
                    if target.startswith(sessions_root + os.sep) and target.endswith(".jsonl"):
                        active_paths[target] = pid
                except OSError:
                    pass
        except OSError:
            pass
    return active_paths, children, commands


def has_working_child(pid, children, commands):
    queue = list(children.get(pid, []))
    visited = set()
    helpers = {"codex", "node", "codex-code-mode-host"}
    while queue:
        child = queue.pop()
        if child in visited:
            continue
        visited.add(child)
        if commands.get(child, "").lower() not in helpers:
            return True
        queue.extend(children.get(child, []))
    return False


def attention_detail(tool_name):
    name = tool_name.lower()
    if "request_user_input" in name:
        return "Codex 正在等待你的选择"
    if "permission" in name:
        return "Codex 正在请求权限"
    if "apply_patch" in name or "write" in name:
        return "文件修改等待确认"
    if "mcp" in name:
        return "外部工具调用等待确认"
    return "命令执行等待确认"


def needs_attention(call, approval_mode, working_child, now):
    name = call.get("name", "").lower()
    started_at = call.get("started_at")
    if started_at and now - started_at < 1.2:
        return False
    if "request_user_input" in name or "requestpermission" in name:
        return True
    if str(approval_mode).lower() == "never" or working_child:
        return False
    return any(part in name for part in ("exec", "shell", "apply_patch", "write", "permission", "mcp"))


def detect_state(path, approval_mode, active_pid, working_child, modified_at, now):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 524288))
            data = handle.read()
        if size > len(data) and b"\n" in data:
            data = data.split(b"\n", 1)[1]
    except OSError:
        state = "active" if active_pid else "failed"
        return state, "Codex 正在运行" if active_pid else "会话记录不可读", modified_at, None, None

    lines = data.splitlines()
    unfinished = False
    found_boundary = False
    terminal_state = None
    terminal_detail = None
    completion_token = None
    last_event_at = None
    last_prompt_value = None
    resolved_calls = set()
    latest_call = None

    for raw in reversed(lines):
        root = json_line(raw)
        if not isinstance(root, dict):
            continue
        payload = root.get("payload")
        if not isinstance(payload, dict):
            continue
        timestamp = parse_time(root.get("timestamp"))
        if timestamp is not None and last_event_at is None:
            last_event_at = timestamp
        outer_type = root.get("type")
        payload_type = payload.get("type")
        if last_prompt_value is None:
            last_prompt_value = prompt_from_record(root)
        if outer_type == "event_msg":
            if not found_boundary and payload_type == "task_started":
                unfinished = True
                found_boundary = True
            elif not found_boundary and payload_type == "task_complete":
                terminal_state = "completed"
                terminal_detail = "本轮任务已完成"
                completion_token = clean(payload.get("turn_id")) or clean(root.get("timestamp"))
                if completion_token is None and payload.get("completed_at") is not None:
                    completion_token = str(payload.get("completed_at"))
                found_boundary = True
            elif not found_boundary and payload_type == "turn_aborted":
                terminal_state = "failed"
                terminal_detail = "任务已中止"
                found_boundary = True
            elif not found_boundary and payload_type == "error":
                terminal_state = "failed"
                error = payload.get("message") or payload.get("error")
                if isinstance(error, dict):
                    error = error.get("message")
                terminal_detail = clean(error, 160) or "Codex 执行出错"
                found_boundary = True
        if found_boundary and last_prompt_value:
            break
        if found_boundary or outer_type != "response_item":
            continue
        if payload_type in ("function_call_output", "custom_tool_call_output"):
            call_id = payload.get("call_id")
            if isinstance(call_id, str):
                resolved_calls.add(call_id)
        elif payload_type in ("function_call", "custom_tool_call"):
            call_id = payload.get("call_id") or payload.get("id")
            if latest_call is None and isinstance(call_id, str) and call_id not in resolved_calls:
                latest_call = {"name": str(payload.get("name") or "tool"), "started_at": timestamp}

    updated_at = last_event_at or modified_at or now
    if not found_boundary and active_pid and latest_call:
        unfinished = True
    if unfinished:
        if latest_call and needs_attention(latest_call, approval_mode, working_child, now):
            return "attention", attention_detail(latest_call["name"]), latest_call.get("started_at") or updated_at, last_prompt_value, None
        if active_pid or now - modified_at < 12:
            detail = "正在执行命令" if working_child else "Codex 正在思考与执行"
            return "active", detail, updated_at, last_prompt_value, None
        return "failed", "会话意外停止，没有完成事件", updated_at, last_prompt_value, None
    if terminal_state:
        return terminal_state, terminal_detail, updated_at, last_prompt_value, completion_token
    if active_pid:
        return "active", "Codex 会话已启动", updated_at, last_prompt_value, None
    return "completed", "会话当前空闲", updated_at, last_prompt_value, None


def open_database(database_path):
    direct_error = None
    try:
        connection = sqlite3.connect(
            "file:{}?mode=ro".format(database_path), uri=True, timeout=1
        )
        connection.execute("PRAGMA schema_version").fetchone()
        return connection
    except sqlite3.Error as exc:
        direct_error = exc
        try:
            connection.close()
        except (NameError, sqlite3.Error):
            pass

    snapshot_root = tempfile.mkdtemp(prefix="codex-pulse-db-")
    atexit.register(shutil.rmtree, snapshot_root, ignore_errors=True)
    snapshot_path = os.path.join(snapshot_root, os.path.basename(database_path))
    try:
        shutil.copy2(database_path, snapshot_path)
        for suffix in ("-wal",):
            source = database_path + suffix
            if os.path.isfile(source):
                shutil.copy2(source, snapshot_path + suffix)
        connection = sqlite3.connect(snapshot_path, timeout=1)
        connection.execute("PRAGMA schema_version").fetchone()
        return connection
    except (OSError, sqlite3.Error) as snapshot_error:
        raise sqlite3.OperationalError(
            "direct read failed ({}); snapshot read failed ({})".format(
                direct_error, snapshot_error
            )
        ) from snapshot_error


def main():
    codex_home = os.path.abspath(os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex")))
    database_path = os.path.join(codex_home, "state_5.sqlite")
    sessions_root = os.path.join(codex_home, "sessions")
    active_paths, children, commands = process_snapshot(sessions_root)
    connection = open_database(database_path)
    connection.row_factory = sqlite3.Row
    columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)").fetchall()}

    def column(name, fallback):
        return name if name in columns else fallback

    def first_text(names, fallback):
        values = ["NULLIF({}, '')".format(name) for name in names if name in columns]
        values.append(fallback)
        return "COALESCE({})".format(", ".join(values))

    title_expression = first_text(("name", "title", "preview"), "id")
    prompt_expression = first_text(("preview", "first_user_message", "title"), "id")
    conditions = []
    if "archived" in columns:
        conditions.append("archived = 0")
    if "source" in columns:
        conditions.append("source = 'cli'")
    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    query = (
        "SELECT id, rollout_path, {updated} AS updated_at, {source} AS source, {cwd} AS cwd, "
        "{title} AS title, {approval} AS approval_mode, {model} AS model, "
        "{prompt} AS fallback_prompt FROM threads{where} ORDER BY updated_at DESC LIMIT 100"
    ).format(
        updated=column("updated_at", "0"), source=column("source", "'cli'"),
        cwd=column("cwd", "''"), title=title_expression,
        approval=column("approval_mode", "'never'"), model=column("model", "''"),
        prompt=prompt_expression, where=where,
    )
    rows = connection.execute(query).fetchall()
    now = time.time()
    sessions = []
    for row in rows:
        path = os.path.abspath(os.path.expanduser(row["rollout_path"] or ""))
        if not path or not os.path.isfile(path):
            continue
        modified_at = os.path.getmtime(path)
        pid = active_paths.get(path)
        working_child = has_working_child(pid, children, commands) if pid else False
        state, detail, updated_at, prompt, completion_token = detect_state(
            path, row["approval_mode"] or "never", pid, working_child, modified_at, now
        )
        prompt = prompt or latest_prompt(path) or clean(row["fallback_prompt"]) or clean(row["title"]) or row["id"]
        cwd = row["cwd"] or ""
        item = {
            "id": row["id"],
            "title": clean(row["title"]) or row["id"],
            "lastPrompt": prompt,
            "cwd": cwd,
            "projectName": os.path.basename(cwd.rstrip(os.sep)) if cwd else "",
            "state": state,
            "detail": detail,
            "updatedAt": updated_at * 1000,
        }
        if row["model"]:
            item["model"] = row["model"]
        if pid:
            item["pid"] = pid
        if completion_token:
            item["completionToken"] = completion_token
        sessions.append(item)
    connection.close()
    print(json.dumps({"sessions": sessions}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("{}: {}".format(type(exc).__name__, exc), file=sys.stderr)
        sys.exit(1)
