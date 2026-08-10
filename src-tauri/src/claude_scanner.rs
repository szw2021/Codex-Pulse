use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use crate::{
    models::{ProcessInfo, Session},
    scanner::{clean_optional, parse_json_timestamp, system_time_millis, tail_data},
    session_process::claude_processes_by_cwd,
};

const MAX_TAIL_BYTES: u64 = 512 * 1024;
const RECENT_ACTIVE_MILLIS: i64 = 60_000;

#[derive(Clone)]
struct ParseCache {
    file_size: u64,
    modified_at: i64,
    info: TranscriptInfo,
}

pub struct ClaudeScanner {
    claude_home: PathBuf,
    parse_cache: HashMap<PathBuf, ParseCache>,
}

impl ClaudeScanner {
    pub fn new(claude_home: PathBuf) -> Self {
        Self {
            claude_home,
            parse_cache: HashMap::new(),
        }
    }

    pub fn scan_sessions(&mut self) -> Result<Vec<Session>, String> {
        let projects_root = self.claude_home.join("projects");
        if !projects_root.is_dir() {
            return Ok(Vec::new());
        }
        let mut entries = collect_jsonl_files(&projects_root);
        entries.sort_by_key(|entry| Reverse(entry.1));
        entries.truncate(100);

        let processes = claude_processes_by_cwd();
        let now = system_time_millis_now();
        let mut sessions = Vec::new();
        let mut scanned_paths = HashSet::new();

        for (path, modified_at, size) in entries {
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            scanned_paths.insert(canonical.clone());
            let cached = self
                .parse_cache
                .get(&canonical)
                .filter(|entry| entry.file_size == size && entry.modified_at == modified_at);
            let info = if let Some(entry) = cached {
                entry.info.clone()
            } else {
                let Ok(data) = tail_data(&canonical, MAX_TAIL_BYTES) else {
                    continue;
                };
                if data.is_empty() {
                    continue;
                }
                let info = analyze_transcript(&data);
                self.parse_cache.insert(
                    canonical.clone(),
                    ParseCache {
                        file_size: size,
                        modified_at,
                        info: info.clone(),
                    },
                );
                info
            };
            // 子代理转录、以及没有任何有效对话记录的文件不作为会话展示
            if info.sidechain_only || info.cwd.is_empty() {
                continue;
            }

            let process_info = Path::new(&info.cwd)
                .canonicalize()
                .ok()
                .and_then(|cwd| processes.get(&cwd).copied());
            let resolved = resolve_state(&info, process_info, modified_at, now);

            let session_id = info
                .session_id
                .clone()
                .or_else(|| canonical.file_stem().and_then(|s| s.to_str()).map(String::from))
                .unwrap_or_else(|| "unknown".into());
            let short_id: String = session_id.chars().take(8).collect();
            let project_name = Path::new(&info.cwd)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&info.cwd)
                .to_string();
            let title = info
                .title
                .clone()
                .unwrap_or_else(|| format!("Claude 会话 {short_id}"));
            let last_prompt = info.last_prompt.clone().unwrap_or_else(|| title.clone());
            let completion_key = resolved
                .completion_token
                .as_ref()
                .map(|token| format!("{session_id}:{token}"));
            // 进程按目录匹配，只在回合未结束时视为"占用"，
            // 避免同目录里已完成的会话被误判为不可恢复。
            let pid = resolved
                .occupied
                .then(|| process_info.map(|value| value.pid))
                .flatten();

            sessions.push(Session {
                id: session_id,
                short_id,
                title,
                last_prompt,
                cwd: info.cwd.clone(),
                project_name,
                source: "cli".into(),
                agent: "claude".into(),
                rollout_path: canonical.to_string_lossy().into_owned(),
                state: resolved.state,
                detail: resolved.detail,
                updated_at: resolved.updated_at,
                activities: Vec::new(),
                model: None,
                pid,
                writer_owner: None,
                writer_tty: None,
                completion_key,
                remote_session_id: None,
                remote_host: None,
            });
        }

        self.parse_cache
            .retain(|path, _| scanned_paths.contains(path));
        sessions.sort_by(|left, right| {
            state_priority(&left.state)
                .cmp(&state_priority(&right.state))
                .then_with(|| right.updated_at.cmp(&left.updated_at))
        });
        Ok(sessions)
    }
}

fn collect_jsonl_files(root: &Path) -> Vec<(PathBuf, i64, u64)> {
    let mut entries = Vec::new();
    let Ok(project_dirs) = fs::read_dir(root) else {
        return entries;
    };
    for project_entry in project_dirs.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&project_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(metadata) = file_entry.metadata() else {
                continue;
            };
            if !metadata.is_file() || metadata.len() == 0 {
                continue;
            }
            let modified = system_time_millis(metadata.modified().unwrap_or(UNIX_EPOCH));
            entries.push((path, modified, metadata.len()));
        }
    }
    entries
}

/// 从转录尾部提取的会话元数据与回合进度。
///
/// Claude 在每个回合结束时向文件尾部追加 `last-prompt`（和 `ai-title`）记录，
/// 因此"最后一条 last-prompt 之后是否还有对话活动"就是精确的回合边界。
#[derive(Clone, Default)]
pub(crate) struct TranscriptInfo {
    pub session_id: Option<String>,
    pub cwd: String,
    pub title: Option<String>,
    pub last_prompt: Option<String>,
    pub permission_mode: String,
    pub last_timestamp: Option<i64>,
    /// 尾部窗口内出现过 last-prompt 记录（新格式转录）
    pub saw_turn_marker: bool,
    /// 最后一条 last-prompt 之后仍有对话活动 → 回合未结束
    pub turn_open: bool,
    /// 最后一条活动是用户中断标记
    pub ends_with_interrupt: bool,
    /// 尾部悬挂的 tool_use（已发起、未收到 tool_result）的工具名
    pub dangling_tool: Option<String>,
    /// 尾部 assistant 消息以正文结束时的 uuid，用作完成确认 token
    pub trailing_assistant_text_uuid: Option<String>,
    /// 全部对话记录都是子代理（sidechain）记录
    pub sidechain_only: bool,
}

pub(crate) fn analyze_transcript(data: &[u8]) -> TranscriptInfo {
    let text = String::from_utf8_lossy(data);
    let mut info = TranscriptInfo::default();
    let mut main_activity = false;
    let mut any_activity = false;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(value) = record.get("sessionId").and_then(Value::as_str) {
            info.session_id = Some(value.to_string());
        }
        // 取第一条 cwd（会话启动目录）：后续记录的 cwd 会随会话内 shell
        // 切换目录漂移，而进程匹配和 resume 都需要启动目录。
        if info.cwd.is_empty()
            && let Some(value) = record.get("cwd").and_then(Value::as_str)
            && !value.is_empty()
        {
            info.cwd = value.to_string();
        }
        if let Some(value) = record.get("timestamp").and_then(parse_json_timestamp) {
            info.last_timestamp = Some(value);
        }
        if let Some(value) = record.get("permissionMode").and_then(Value::as_str) {
            info.permission_mode = value.to_string();
        }
        let sidechain = record
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        match record.get("type").and_then(Value::as_str).unwrap_or("") {
            "ai-title" => {
                if let Some(value) = record.get("aiTitle").and_then(Value::as_str) {
                    info.title = clean_optional(value, 100);
                }
            }
            "last-prompt" => {
                if let Some(value) = record.get("lastPrompt").and_then(Value::as_str)
                    && let Some(prompt) = clean_optional(value, 500)
                {
                    info.last_prompt = Some(prompt);
                }
                info.saw_turn_marker = true;
                info.turn_open = false;
                info.ends_with_interrupt = false;
                info.dangling_tool = None;
            }
            "user" => {
                if record.get("isMeta").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                let Some(event) = classify_user_message(&record) else {
                    continue;
                };
                any_activity = true;
                main_activity |= !sidechain;
                info.turn_open = true;
                info.dangling_tool = None;
                info.trailing_assistant_text_uuid = None;
                info.ends_with_interrupt = matches!(event, UserEvent::Interrupt);
                if let UserEvent::Prompt(prompt) = event
                    && !sidechain
                {
                    info.last_prompt = Some(prompt);
                }
            }
            "assistant" => {
                any_activity = true;
                main_activity |= !sidechain;
                info.turn_open = true;
                info.ends_with_interrupt = false;
                info.dangling_tool = None;
                info.trailing_assistant_text_uuid = None;
                let content = record.get("message").and_then(|m| m.get("content"));
                match trailing_content(content) {
                    Some(("tool_use", name)) => info.dangling_tool = Some(name),
                    Some(("text", _)) => {
                        info.trailing_assistant_text_uuid = record
                            .get("uuid")
                            .and_then(Value::as_str)
                            .map(String::from);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    info.sidechain_only = any_activity && !main_activity;
    info
}

enum UserEvent {
    Prompt(String),
    ToolResult,
    Interrupt,
}

fn classify_user_message(record: &Value) -> Option<UserEvent> {
    let content = record.get("message")?.get("content")?;
    if let Some(text) = content.as_str() {
        if text.starts_with("[Request interrupted by user") {
            return Some(UserEvent::Interrupt);
        }
        if is_meta_text(text) {
            return None;
        }
        return Some(match clean_optional(text, 500) {
            Some(prompt) => UserEvent::Prompt(prompt),
            None => UserEvent::ToolResult,
        });
    }
    let items = content.as_array()?;
    let mut parts = Vec::new();
    let mut saw_tool_result = false;
    for item in items {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" | "input_text" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if text.starts_with("[Request interrupted by user") {
                        return Some(UserEvent::Interrupt);
                    }
                    parts.push(text);
                }
            }
            "tool_result" => saw_tool_result = true,
            _ => {}
        }
    }
    let text = parts.join(" ");
    if is_meta_text(&text) {
        return None;
    }
    match clean_optional(&text, 500) {
        Some(prompt) => Some(UserEvent::Prompt(prompt)),
        None if saw_tool_result => Some(UserEvent::ToolResult),
        None => None,
    }
}

/// 本地命令回显、系统注入等不是用户提示词
fn is_meta_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<command-")
        || trimmed.starts_with("<local-command")
        || trimmed.starts_with("<system-reminder>")
        || trimmed.starts_with("Caveat:")
}

/// 返回 assistant 消息末尾内容块的 (类型, 工具名/空)
fn trailing_content(content: Option<&Value>) -> Option<(&'static str, String)> {
    let content = content?;
    if let Some(text) = content.as_str() {
        return (!text.trim().is_empty()).then(|| ("text", String::new()));
    }
    let item = content.as_array()?.iter().next_back()?;
    match item.get("type").and_then(Value::as_str)? {
        "tool_use" => Some((
            "tool_use",
            item.get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
        )),
        "text" => Some(("text", String::new())),
        _ => Some(("other", String::new())),
    }
}

#[derive(Clone)]
pub(crate) struct ResolvedState {
    pub state: String,
    pub detail: String,
    pub updated_at: i64,
    pub completion_token: Option<String>,
    /// 回合未结束且检测到进程时，认为该进程占用本会话
    pub occupied: bool,
}

pub(crate) fn resolve_state(
    info: &TranscriptInfo,
    process_info: Option<ProcessInfo>,
    file_modified_at: i64,
    now: i64,
) -> ResolvedState {
    let updated_at = info.last_timestamp.unwrap_or(if file_modified_at > 0 {
        file_modified_at
    } else {
        now
    });
    let make = |state: &str, detail: &str, token: Option<String>, occupied: bool| ResolvedState {
        state: state.into(),
        detail: detail.into(),
        updated_at,
        completion_token: token,
        occupied,
    };
    let completed = |detail_done: bool| {
        let token = info.trailing_assistant_text_uuid.clone();
        if detail_done && token.is_some() {
            make("completed", "本轮任务已完成", token, false)
        } else {
            make("completed", "会话当前空闲", None, false)
        }
    };

    if !info.turn_open {
        // 回合已结束：即使文件刚写入也立即算完成，不再等待 60 秒冷却
        return completed(true);
    }
    if info.ends_with_interrupt {
        return make("failed", "任务已中止", None, false);
    }
    let recent = file_modified_at > 0 && now - file_modified_at < RECENT_ACTIVE_MILLIS;
    if let Some(process) = process_info {
        if !recent
            && !process.has_working_child
            && let Some(tool) = &info.dangling_tool
            && let Some(detail) = attention_detail(tool, &info.permission_mode)
        {
            return make("attention", detail, None, true);
        }
        let detail = if process.has_working_child {
            "正在执行命令"
        } else {
            "Claude 正在思考与执行"
        };
        return make("active", detail, None, true);
    }
    if recent {
        return make("active", "Claude 正在处理", None, false);
    }
    if info.saw_turn_marker {
        // 新格式转录：回合没关闭、进程也不在了 → 意外停止
        return make("failed", "会话意外停止，没有完成事件", None, false);
    }
    // 旧格式（尾部窗口内没有 last-prompt 记录）：按尾部形状退化判断
    completed(info.dangling_tool.is_none() && info.trailing_assistant_text_uuid.is_some())
}

/// 悬挂的 tool_use 是否可能在等待用户确认。
/// 长时间运行的内部工具（Task/WebFetch 等）不会弹确认，保持 active。
fn attention_detail(tool: &str, permission_mode: &str) -> Option<&'static str> {
    if permission_mode == "bypassPermissions" {
        return None;
    }
    let lower = tool.to_lowercase();
    if lower.contains("askuserquestion") {
        return Some("Claude 正在等待你的选择");
    }
    if lower.contains("exitplanmode") {
        return Some("计划等待确认");
    }
    if lower.contains("edit") || lower.contains("write") {
        return (permission_mode != "acceptEdits").then_some("文件修改等待确认");
    }
    if lower.contains("bash") {
        return Some("命令执行等待确认");
    }
    if lower.starts_with("mcp__") {
        return Some("外部工具调用等待确认");
    }
    None
}

fn system_time_millis_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn state_priority(state: &str) -> u8 {
    match state {
        "attention" => 0,
        "active" => 1,
        "completed" => 2,
        "failed" => 3,
        _ => 99,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 2_000_000_000_000;

    fn ts(ago_millis: i64) -> String {
        chrono::DateTime::from_timestamp_millis(NOW - ago_millis)
            .unwrap()
            .to_rfc3339()
    }

    fn user_message(text: &str, ago_millis: i64) -> String {
        serde_json::json!({
            "type": "user",
            "uuid": "u1",
            "sessionId": "abc-123",
            "cwd": "/tmp/project",
            "timestamp": ts(ago_millis),
            "message": {"role": "user", "content": text}
        })
        .to_string()
    }

    fn assistant_text(uuid: &str, ago_millis: i64) -> String {
        serde_json::json!({
            "type": "assistant",
            "uuid": uuid,
            "sessionId": "abc-123",
            "cwd": "/tmp/project",
            "timestamp": ts(ago_millis),
            "message": {"role": "assistant", "content": [{"type": "text", "text": "完成了"}]}
        })
        .to_string()
    }

    fn assistant_tool_use(name: &str, ago_millis: i64) -> String {
        serde_json::json!({
            "type": "assistant",
            "uuid": "a-tool",
            "sessionId": "abc-123",
            "cwd": "/tmp/project",
            "timestamp": ts(ago_millis),
            "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "tu1", "name": name}]}
        })
        .to_string()
    }

    fn turn_marker(prompt: &str) -> String {
        serde_json::json!({
            "type": "last-prompt",
            "lastPrompt": prompt,
            "sessionId": "abc-123"
        })
        .to_string()
    }

    fn resolve(lines: &[String], process: Option<ProcessInfo>, modified_ago_secs: i64) -> ResolvedState {
        let info = analyze_transcript(lines.join("\n").as_bytes());
        resolve_state(&info, process, NOW - modified_ago_secs * 1000, NOW)
    }

    fn idle_process() -> Option<ProcessInfo> {
        Some(ProcessInfo {
            pid: 9,
            has_working_child: false,
        })
    }

    #[test]
    fn completed_immediately_when_turn_marker_trails() {
        // 回合结束（last-prompt 收尾）即完成，即使文件刚写入、进程还在
        let lines = [
            user_message("帮我修 bug", 9000),
            assistant_text("a1", 5000),
            turn_marker("帮我修 bug"),
        ];
        let result = resolve(&lines, idle_process(), 2);
        assert_eq!(result.state, "completed");
        assert_eq!(result.detail, "本轮任务已完成");
        assert_eq!(result.completion_token.as_deref(), Some("a1"));
        assert!(!result.occupied);
    }

    #[test]
    fn active_when_turn_open_with_process() {
        let lines = [
            turn_marker("旧提示"),
            user_message("跑测试", 5000),
            assistant_tool_use("Read", 3000),
            user_message("", 2000), // tool_result 占位由下方数组形式覆盖
        ];
        let result = resolve(&lines[..3], idle_process(), 120);
        // 悬挂 Read 不触发确认提醒（不属于需审批工具）→ active
        assert_eq!(result.state, "active");
        assert!(result.occupied);
    }

    #[test]
    fn attention_when_bash_tool_dangles_with_idle_process() {
        let lines = [
            turn_marker("旧提示"),
            user_message("跑测试", 65_000),
            assistant_tool_use("Bash", 62_000),
        ];
        let result = resolve(&lines, idle_process(), 62);
        assert_eq!(result.state, "attention");
        assert_eq!(result.detail, "命令执行等待确认");
        // 工作子进程存在时说明命令在跑，不是等待确认
        let working = Some(ProcessInfo {
            pid: 9,
            has_working_child: true,
        });
        assert_eq!(resolve(&lines, working, 62).state, "active");
    }

    #[test]
    fn failed_when_turn_open_without_process() {
        let lines = [
            turn_marker("旧提示"),
            user_message("跑测试", 300_000),
            assistant_tool_use("Bash", 290_000),
        ];
        let result = resolve(&lines, None, 290);
        assert_eq!(result.state, "failed");
        assert_eq!(result.detail, "会话意外停止，没有完成事件");
    }

    #[test]
    fn active_when_recently_written_without_process() {
        let lines = [
            turn_marker("旧提示"),
            user_message("帮我修 bug", 10_000),
        ];
        assert_eq!(resolve(&lines, None, 10).state, "active");
    }

    #[test]
    fn failed_on_user_interrupt() {
        let interrupt = serde_json::json!({
            "type": "user",
            "sessionId": "abc-123",
            "cwd": "/tmp/project",
            "timestamp": ts(5000),
            "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user]"}]}
        })
        .to_string();
        let lines = [
            turn_marker("旧提示"),
            user_message("跑测试", 9000),
            interrupt,
        ];
        let result = resolve(&lines, None, 120);
        assert_eq!(result.state, "failed");
        assert_eq!(result.detail, "任务已中止");
    }

    #[test]
    fn legacy_transcript_without_marker_falls_back_to_shape() {
        // 旧格式：没有 last-prompt 记录，以 assistant 正文收尾 → 完成
        let lines = [user_message("帮我修 bug", 9000), assistant_text("a1", 5000)];
        let result = resolve(&lines, None, 120);
        assert_eq!(result.state, "completed");
        assert_eq!(result.completion_token.as_deref(), Some("a1"));
    }

    #[test]
    fn newest_user_prompt_wins_over_stale_marker() {
        // 回合进行中：新输入的提示词应覆盖上一回合的 last-prompt
        let lines = [
            user_message("第一个问题", 90_000),
            assistant_text("a1", 80_000),
            turn_marker("第一个问题"),
            user_message("第二个问题", 5000),
        ];
        let info = analyze_transcript(lines.join("\n").as_bytes());
        assert_eq!(info.last_prompt.as_deref(), Some("第二个问题"));
        assert!(info.turn_open);
    }

    #[test]
    fn extracts_metadata_and_skips_meta_records() {
        let records = [
            serde_json::json!({
                "type": "ai-title",
                "sessionId": "s1",
                "aiTitle": "加 Claude 支持"
            })
            .to_string(),
            serde_json::json!({
                "type": "user",
                "sessionId": "s1",
                "cwd": "/work/app",
                "timestamp": ts(9000),
                "message": {"role": "user", "content": "<command-name>/clear</command-name>"}
            })
            .to_string(),
            serde_json::json!({
                "type": "user",
                "sessionId": "s1",
                "cwd": "/work/app",
                "timestamp": ts(5000),
                "message": {"role": "user", "content": "真正的提问"}
            })
            .to_string(),
        ];
        let info = analyze_transcript(records.join("\n").as_bytes());
        assert_eq!(info.session_id.as_deref(), Some("s1"));
        assert_eq!(info.cwd, "/work/app");
        assert_eq!(info.title.as_deref(), Some("加 Claude 支持"));
        assert_eq!(info.last_prompt.as_deref(), Some("真正的提问"));
    }

    #[test]
    fn sidechain_only_transcripts_are_flagged() {
        let record = serde_json::json!({
            "type": "user",
            "isSidechain": true,
            "sessionId": "s1",
            "cwd": "/work/app",
            "timestamp": ts(5000),
            "message": {"role": "user", "content": "子代理任务"}
        })
        .to_string();
        assert!(analyze_transcript(record.as_bytes()).sidechain_only);
    }
}
