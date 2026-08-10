use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
};

use crate::models::ProcessInfo;

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

/// Claude 写 jsonl 是"打开-写入-关闭"，lsof 扫描会话目录看不到句柄。
/// 改为列出所有 claude 进程的工作目录：进程的 cwd 就是它所属会话记录的 cwd。
pub(crate) fn claude_processes_by_cwd() -> HashMap<PathBuf, ProcessInfo> {
    let lsof = Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-c", "claude", "-F", "pn"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    let tree = process_tree();
    let mut map: HashMap<PathBuf, ProcessInfo> = HashMap::new();
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
            let info = ProcessInfo {
                pid,
                has_working_child: has_working_descendant(pid, &tree),
            };
            // 同一目录多个进程时保留"正在干活"的那个
            map.entry(path)
                .and_modify(|existing| {
                    if info.has_working_child && !existing.has_working_child {
                        *existing = info;
                    }
                })
                .or_insert(info);
        }
    }
    map
}

fn process_tree() -> HashMap<u32, Vec<(u32, String)>> {
    let ps = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,comm="])
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
        let name = lower.rsplit('/').next().unwrap_or(&lower);
        let helper = matches!(
            name,
            "codex" | "codex-code-mode-host" | "node" | "claude" | "caffeinate" | "zsh" | "bash"
                | "sh"
        );
        if !helper {
            return true;
        }
        queue.extend(tree.get(&pid).cloned().unwrap_or_default());
    }
    false
}
