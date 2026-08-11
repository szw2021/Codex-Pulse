use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use serde_json::Value;
use wait_timeout::ChildExt;

use crate::models::ProcessInfo;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeAgentStatus {
    Active,
    Attention,
    Idle,
    Failed,
    Stopped,
    Unknown,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ClaudeProcessInfo {
    pub pid: u32,
    pub has_working_child: bool,
    pub status: Option<ClaudeAgentStatus>,
    pub exact: bool,
}

#[derive(Clone, Default)]
pub(crate) struct ClaudeProcessSnapshot {
    exact: Option<HashMap<String, ClaudeProcessInfo>>,
    by_cwd: HashMap<PathBuf, ClaudeProcessInfo>,
}

impl ClaudeProcessSnapshot {
    pub fn for_session(&self, session_id: &str, cwd: &Path) -> Option<ClaudeProcessInfo> {
        if let Some(exact) = &self.exact {
            return exact.get(session_id).copied();
        }
        self.by_cwd.get(cwd).copied()
    }
}

pub(crate) fn active_session_processes(sessions_root: &Path) -> HashMap<PathBuf, ProcessInfo> {
    let lsof = Command::new("/usr/sbin/lsof")
        .args(["-F", "pn", "+D"])
        .arg(sessions_root)
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    let tree = process_tree();
    let mut path_pids = HashMap::new();
    let mut current_pid = None;
    for line in lsof.lines() {
        if let Some(value) = line.strip_prefix('p') {
            current_pid = value.parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix('n')
            && value.ends_with(".jsonl")
            && let Some(pid) = current_pid
        {
            let path = PathBuf::from(value)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(value));
            path_pids.insert(path, pid);
        }
    }
    path_pids
        .into_iter()
        .map(|(path, pid)| {
            (
                path,
                ProcessInfo {
                    pid,
                    has_working_child: has_working_descendant(pid, &tree),
                },
            )
        })
        .collect()
}

/// 新版 Claude 提供带 sessionId 的精确状态；旧版再按 cwd 回退。
pub(crate) fn claude_processes() -> ClaudeProcessSnapshot {
    let tree = process_tree();
    if let Some(exact) = claude_agents(&tree) {
        return ClaudeProcessSnapshot {
            exact: Some(exact),
            by_cwd: HashMap::new(),
        };
    }

    let lsof = Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-c", "claude", "-F", "pn"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    let mut by_cwd: HashMap<PathBuf, ClaudeProcessInfo> = HashMap::new();
    let mut current_pid = None;
    for line in lsof.lines() {
        if let Some(value) = line.strip_prefix('p') {
            current_pid = value.parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix('n')
            && let Some(pid) = current_pid.take()
        {
            let path = PathBuf::from(value)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(value));
            let info = ClaudeProcessInfo {
                pid,
                has_working_child: has_working_descendant(pid, &tree),
                status: None,
                exact: false,
            };
            // 同一目录多个进程时保留"正在干活"的那个
            by_cwd
                .entry(path)
                .and_modify(|existing| {
                    if info.has_working_child && !existing.has_working_child {
                        *existing = info;
                    }
                })
                .or_insert(info);
        }
    }
    ClaudeProcessSnapshot {
        exact: None,
        by_cwd,
    }
}

fn claude_agents(
    tree: &HashMap<u32, Vec<(u32, String)>>,
) -> Option<HashMap<String, ClaudeProcessInfo>> {
    for executable in claude_executables() {
        let Some(data) = run_claude_agents(&executable) else {
            continue;
        };
        if let Some(processes) = parse_claude_agents(&data, tree) {
            return Some(processes);
        }
    }
    None
}

fn claude_executables() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/bin/claude"));
        paths.push(home.join(".npm-global/bin/claude"));
        paths.push(home.join(".claude/local/claude"));
    }
    paths.push(PathBuf::from("claude"));
    paths
}

fn run_claude_agents(executable: &Path) -> Option<Vec<u8>> {
    let mut child = Command::new(executable)
        .args(["agents", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let Some(status) = child.wait_timeout(Duration::from_secs(3)).ok()? else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    if !status.success() {
        return None;
    }
    let mut data = Vec::new();
    child.stdout.take()?.read_to_end(&mut data).ok()?;
    Some(data)
}

fn parse_claude_agents(
    data: &[u8],
    tree: &HashMap<u32, Vec<(u32, String)>>,
) -> Option<HashMap<String, ClaudeProcessInfo>> {
    let entries = serde_json::from_slice::<Value>(data).ok()?;
    let entries = entries.as_array()?;
    let mut processes = HashMap::new();
    for entry in entries {
        let Some(session_id) = entry.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let Some(pid) = entry
            .get("pid")
            .and_then(Value::as_u64)
            .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
            .map(|pid| pid as u32)
        else {
            continue;
        };
        let status = entry
            .get("status")
            .and_then(Value::as_str)
            .map(claude_agent_status)
            .unwrap_or(ClaudeAgentStatus::Unknown);
        processes.insert(
            session_id.to_string(),
            ClaudeProcessInfo {
                pid,
                has_working_child: has_working_descendant(pid, tree),
                status: Some(status),
                exact: true,
            },
        );
    }
    (entries.is_empty() || !processes.is_empty()).then_some(processes)
}

fn claude_agent_status(value: &str) -> ClaudeAgentStatus {
    let normalized: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    match normalized.as_str() {
        "active" | "running" | "working" => ClaudeAgentStatus::Active,
        "attention" | "blocked" | "needsinput" | "waiting" => ClaudeAgentStatus::Attention,
        "completed" | "done" | "idle" => ClaudeAgentStatus::Idle,
        "error" | "failed" => ClaudeAgentStatus::Failed,
        "cancelled" | "stopped" | "terminated" => ClaudeAgentStatus::Stopped,
        _ => ClaudeAgentStatus::Unknown,
    }
}

fn process_tree() -> HashMap<u32, Vec<(u32, String)>> {
    let ps = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    let mut tree: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
    for line in ps.lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(parent) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        tree.entry(parent)
            .or_default()
            .push((pid, fields.collect::<Vec<_>>().join(" ")));
    }
    tree
}

fn has_working_descendant(root: u32, tree: &HashMap<u32, Vec<(u32, String)>>) -> bool {
    let mut queue = tree.get(&root).cloned().unwrap_or_default();
    let mut visited = HashSet::new();
    while let Some((pid, command)) = queue.pop() {
        if !visited.insert(pid) {
            continue;
        }
        // 常驻辅助进程不算"正在干活"，但它们的子进程（真正在跑的命令）算。
        // claude 的常驻子进程包括快照 shell（zsh/bash）与 caffeinate。
        let lower = command.to_lowercase();
        let executable = lower.split_whitespace().next().unwrap_or(&lower);
        let name = executable.rsplit('/').next().unwrap_or(executable);
        let helper = matches!(
            name,
            "codex"
                | "codex-code-mode-host"
                | "node"
                | "claude"
                | "caffeinate"
                | "zsh"
                | "bash"
                | "sh"
        );
        let persistent_service = lower.contains("mcp") && lower.contains("server");
        if !helper && !persistent_service {
            return true;
        }
        queue.extend(tree.get(&pid).cloned().unwrap_or_default());
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exact_claude_session_states() {
        let data = br#"[
          {"pid": 12, "sessionId": "working-session", "status": "working"},
          {"pid": 13, "sessionId": "idle-session", "status": "idle"},
          {"pid": 14, "sessionId": "blocked-session", "status": "needs_input"}
        ]"#;
        let processes = parse_claude_agents(data, &HashMap::new()).unwrap();
        assert_eq!(
            processes["working-session"].status,
            Some(ClaudeAgentStatus::Active)
        );
        assert_eq!(
            processes["idle-session"].status,
            Some(ClaudeAgentStatus::Idle)
        );
        assert_eq!(
            processes["blocked-session"].status,
            Some(ClaudeAgentStatus::Attention)
        );
    }

    #[test]
    fn rejects_legacy_agent_definition_output() {
        let data = br#"[{"name":"reviewer","description":"Reviews code"}]"#;
        assert!(parse_claude_agents(data, &HashMap::new()).is_none());
    }

    #[test]
    fn ignores_persistent_mcp_server_but_detects_real_command() {
        let mut tree = HashMap::from([(
            1,
            vec![(
                2,
                "/opt/homebrew/bin/npm exec apifox-mcp-server@latest".into(),
            )],
        )]);
        assert!(!has_working_descendant(1, &tree));

        tree.get_mut(&1)
            .unwrap()
            .push((3, "/bin/zsh -lc sleep 30".into()));
        tree.insert(3, vec![(4, "/bin/sleep 30".into())]);
        assert!(has_working_descendant(1, &tree));
    }
}
