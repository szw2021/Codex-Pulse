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
    let ps = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
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

fn has_working_descendant(root: u32, tree: &HashMap<u32, Vec<(u32, String)>>) -> bool {
    let mut queue = tree.get(&root).cloned().unwrap_or_default();
    let mut visited = HashSet::new();
    while let Some((pid, command)) = queue.pop() {
        if !visited.insert(pid) {
            continue;
        }
        let lower = command.to_lowercase();
        let helper = lower.contains("codex-code-mode-host")
            || lower.ends_with("/codex")
            || lower.ends_with("/node")
            || lower == "codex"
            || lower == "node";
        if !helper {
            return true;
        }
        queue.extend(tree.get(&pid).cloned().unwrap_or_default());
    }
    false
}
