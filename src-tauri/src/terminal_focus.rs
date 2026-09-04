use std::{collections::HashMap, process::Command};

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessRow {
    parent: u32,
    tty: Option<String>,
    command: String,
}

pub fn focus_process_terminal(pid: u32, tty_hint: Option<&str>) -> Result<(), String> {
    let processes = process_snapshot()?;
    let (owner, detected_tty) = terminal_context(pid, &processes);
    let tty = tty_hint
        .and_then(normalize_tty)
        .or(detected_tty)
        .ok_or("检测到了会话进程，但无法确定它所在的终端标签页。")?;

    match owner.as_deref() {
        Some("iTerm2") => focus_iterm(&tty),
        Some("Terminal") => focus_terminal(&tty),
        Some(application) => {
            activate_application(application)?;
            Err(format!(
                "已切换到 {application}，但该终端不支持按标签页精确定位。"
            ))
        }
        None => {
            // 进程树有时在终端升级或 tmux 中断开；TTY 仍可被支持的应用精确匹配。
            if focus_iterm(&tty).is_ok() || focus_terminal(&tty).is_ok() {
                Ok(())
            } else {
                Err(format!("没有找到占用 {tty} 的 Terminal 或 iTerm2 标签页。"))
            }
        }
    }
}

fn process_snapshot() -> Result<HashMap<u32, ProcessRow>, String> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,tty=,command="])
        .output()
        .map_err(|error| format!("无法读取终端进程：{error}"))?;
    if !output.status.success() {
        return Err("无法读取终端进程。".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut processes = HashMap::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(parent) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let tty = fields.next().and_then(normalize_tty);
        processes.insert(
            pid,
            ProcessRow {
                parent,
                tty,
                command: fields.collect::<Vec<_>>().join(" "),
            },
        );
    }
    Ok(processes)
}

fn terminal_context(
    pid: u32,
    processes: &HashMap<u32, ProcessRow>,
) -> (Option<String>, Option<String>) {
    let mut current = pid;
    let mut tty = None;
    for _ in 0..24 {
        let Some(process) = processes.get(&current) else {
            break;
        };
        if tty.is_none() {
            tty.clone_from(&process.tty);
        }
        if let Some(owner) = terminal_owner(&process.command) {
            return (Some(owner.into()), tty);
        }
        if process.parent == 0 || process.parent == current {
            break;
        }
        current = process.parent;
    }
    (None, tty)
}

fn terminal_owner(command: &str) -> Option<&'static str> {
    let command = command.to_ascii_lowercase();
    if command.contains("/iterm.app/") || command.contains("itermserver") {
        Some("iTerm2")
    } else if command.contains("/terminal.app/") {
        Some("Terminal")
    } else if command.contains("/warp.app/") {
        Some("Warp")
    } else if command.contains("/ghostty.app/") {
        Some("Ghostty")
    } else if command.contains("/cursor.app/") || command.contains(".cursor-server") {
        Some("Cursor")
    } else if command.contains("/visual studio code.app/") || command.contains(".vscode-server") {
        Some("Visual Studio Code")
    } else if command.contains("/wezterm") {
        Some("WezTerm")
    } else if command.contains("/kitty.app/") {
        Some("kitty")
    } else if command.contains("/alacritty.app/") {
        Some("Alacritty")
    } else {
        None
    }
}

fn normalize_tty(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || matches!(value, "?" | "??" | "-") {
        return None;
    }
    Some(if value.starts_with("/dev/") {
        value.into()
    } else {
        format!("/dev/{value}")
    })
}

fn focus_iterm(tty: &str) -> Result<(), String> {
    let script = format!(
        r#"set targetTTY to "{}"
tell application "iTerm2"
  repeat with targetWindow in windows
    repeat with targetTab in tabs of targetWindow
      repeat with targetSession in sessions of targetTab
        if tty of targetSession is targetTTY then
          select targetTab
          select targetWindow
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end repeat
end tell
return """#,
        apple_script_string(tty)
    );
    run_focus_script(&script, "iTerm2", tty)
}

fn focus_terminal(tty: &str) -> Result<(), String> {
    let script = format!(
        r#"set targetTTY to "{}"
tell application "Terminal"
  repeat with targetWindow in windows
    repeat with targetTab in tabs of targetWindow
      if tty of targetTab is targetTTY then
        set selected tab of targetWindow to targetTab
        set index of targetWindow to 1
        activate
        return "focused"
      end if
    end repeat
  end repeat
end tell
return """#,
        apple_script_string(tty)
    );
    run_focus_script(&script, "Terminal", tty)
}

fn run_focus_script(script: &str, application: &str, tty: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|error| format!("无法切换到 {application}：{error}"))?;
    if output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "focused" {
        Ok(())
    } else {
        Err(format!("{application} 中没有找到占用 {tty} 的标签页。"))
    }
}

fn activate_application(application: &str) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .args(["-a", application])
        .status()
        .map_err(|error| format!("无法切换到 {application}：{error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| format!("无法切换到 {application}。"))
}

fn apple_script_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_tty_names() {
        assert_eq!(normalize_tty("ttys003"), Some("/dev/ttys003".into()));
        assert_eq!(normalize_tty("/dev/ttys004"), Some("/dev/ttys004".into()));
        assert_eq!(normalize_tty("??"), None);
    }

    #[test]
    fn finds_terminal_and_tty_in_process_ancestry() {
        let processes = HashMap::from([
            (
                42,
                ProcessRow {
                    parent: 21,
                    tty: Some("/dev/ttys003".into()),
                    command: "codex".into(),
                },
            ),
            (
                21,
                ProcessRow {
                    parent: 7,
                    tty: Some("/dev/ttys003".into()),
                    command: "-zsh".into(),
                },
            ),
            (
                7,
                ProcessRow {
                    parent: 1,
                    tty: None,
                    command: "/Applications/iTerm.app/Contents/MacOS/iTerm2".into(),
                },
            ),
        ]);
        assert_eq!(
            terminal_context(42, &processes),
            (Some("iTerm2".into()), Some("/dev/ttys003".into()))
        );
    }

    #[test]
    fn recognizes_supported_terminal_owners() {
        assert_eq!(
            terminal_owner("/Applications/Terminal.app/Contents/MacOS/Terminal"),
            Some("Terminal")
        );
        assert_eq!(
            terminal_owner("/Applications/Warp.app/Contents/MacOS/stable"),
            Some("Warp")
        );
        assert_eq!(terminal_owner("plain-shell"), None);
    }
}
