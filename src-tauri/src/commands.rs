use std::{
    path::Path,
    process::{Command, Stdio},
};

use crate::models::Session;

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn apple_script_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

pub fn resume_command(session: &Session, yolo_enabled: bool, codex_home: &Path) -> String {
    let mode = if yolo_enabled {
        " --dangerously-bypass-approvals-and-sandbox"
    } else {
        ""
    };
    format!(
        "cd {} && CODEX_HOME={} codex resume{} {}",
        shell_quote(&session.cwd),
        shell_quote(&codex_home.to_string_lossy()),
        mode,
        shell_quote(&session.id)
    )
}

// `claude --resume [value]` 不会把紧随其后的 `--flag` 当作会话 ID，
// 所以 YOLO 标志必须放在会话 ID 之后。
pub fn claude_resume_command(session: &Session, yolo_enabled: bool) -> String {
    let mode = if yolo_enabled {
        " --dangerously-skip-permissions"
    } else {
        ""
    };
    format!(
        "cd {} && claude --resume {}{}",
        shell_quote(&session.cwd),
        shell_quote(&session.id),
        mode
    )
}

pub fn remote_resume_command(session: &Session, yolo_enabled: bool) -> String {
    let remote_id = session.remote_session_id.as_deref().unwrap_or(&session.id);
    let path_prefix = if session.agent == "claude" {
        "PATH=\"/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH\""
    } else {
        "PATH=\"/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.codex/packages/standalone/current:$PATH\""
    };
    let remote = if session.agent == "claude" {
        let mode = if yolo_enabled {
            " --dangerously-skip-permissions"
        } else {
            ""
        };
        format!(
            "cd {} && {} claude --resume {}{}",
            shell_quote(&session.cwd),
            path_prefix,
            shell_quote(remote_id),
            mode
        )
    } else {
        let mode = if yolo_enabled {
            " --dangerously-bypass-approvals-and-sandbox"
        } else {
            ""
        };
        format!(
            "cd {} && {} codex resume{} {}",
            shell_quote(&session.cwd),
            path_prefix,
            mode,
            shell_quote(remote_id)
        )
    };
    format!(
        "ssh -t {} {}",
        shell_quote(session.remote_host.as_deref().unwrap_or_default()),
        shell_quote(&remote)
    )
}

pub fn new_codex_yolo_command(directory: &Path) -> String {
    format!(
        "cd {} && codex --yolo",
        shell_quote(&directory.to_string_lossy())
    )
}

pub fn launch_terminal(command: &str, title: Option<&str>) -> Result<(), String> {
    if application_exists("iTerm") {
        run_apple_script(&iterm_launch_script(command, title), "iTerm2")
    } else {
        run_apple_script(&terminal_launch_script(command), "Terminal")
    }
}

fn application_exists(application: &str) -> bool {
    Command::new("/usr/bin/open")
        .args(["-Ra", application])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn iterm_launch_script(command: &str, title: Option<&str>) -> String {
    let title = terminal_title(title.unwrap_or("Codex"));
    format!(
        "tell application \"iTerm2\"\nactivate\nset targetWindow to (create window with default profile)\nset targetSession to current session of targetWindow\nset name of targetSession to \"{}\"\ntell targetSession to write text \"{}\"\ndelay 1\nset name of targetSession to \"{}\"\nend tell",
        apple_script_string(&title),
        apple_script_string(command),
        apple_script_string(&title),
    )
}

fn terminal_title(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "Codex".into()
    } else {
        cleaned.into()
    }
}

fn terminal_launch_script(command: &str) -> String {
    format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        apple_script_string(command)
    )
}

fn run_apple_script(script: &str, application: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法打开 {application}：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("无法打开 {application}。")
        } else {
            format!("无法打开 {application}：{detail}")
        })
    }
}

pub fn reveal_in_finder(path: &str) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .args(["-R", path])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法在 Finder 中显示：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Session {
        Session {
            id: "abc-123".into(),
            short_id: "abc-123".into(),
            title: "demo".into(),
            last_prompt: "demo".into(),
            cwd: "/tmp/demo folder".into(),
            project_name: "demo folder".into(),
            source: "cli".into(),
            agent: "codex".into(),
            rollout_path: String::new(),
            state: "completed".into(),
            detail: String::new(),
            updated_at: 0,
            activities: Vec::new(),
            model: None,
            pid: None,
            writer_owner: None,
            writer_tty: None,
            completion_key: None,
            remote_session_id: None,
            remote_host: None,
        }
    }

    #[test]
    fn builds_safe_resume_commands() {
        let local = fixture();
        assert_eq!(
            resume_command(&local, false, Path::new("/tmp/codex data")),
            "cd '/tmp/demo folder' && CODEX_HOME='/tmp/codex data' codex resume 'abc-123'"
        );
        let mut remote = fixture();
        remote.source = "remote".into();
        remote.remote_host = Some("dev-box".into());
        remote.remote_session_id = Some("remote-123".into());
        assert!(remote_resume_command(&remote, true).contains("--dangerously-bypass"));
    }

    #[test]
    fn builds_safe_claude_resume_commands() {
        let mut local = fixture();
        local.agent = "claude".into();
        assert_eq!(
            claude_resume_command(&local, false),
            "cd '/tmp/demo folder' && claude --resume 'abc-123'"
        );
        // YOLO 标志必须在会话 ID 之后，否则 --resume 读不到 ID。
        assert!(
            claude_resume_command(&local, true)
                .ends_with("claude --resume 'abc-123' --dangerously-skip-permissions")
        );
    }

    #[test]
    fn builds_remote_claude_resume_command() {
        let mut remote = fixture();
        remote.agent = "claude".into();
        remote.source = "remote".into();
        remote.remote_host = Some("dev-box".into());
        remote.remote_session_id = Some("remote-123".into());
        let command = remote_resume_command(&remote, false);
        assert!(command.starts_with("ssh -t 'dev-box' "));
        assert!(command.contains("claude --resume '\\''remote-123'\\''"));
        let yolo_command = remote_resume_command(&remote, true);
        assert!(
            yolo_command.contains("--resume '\\''remote-123'\\'' --dangerously-skip-permissions")
        );
    }

    #[test]
    fn launches_new_iterm_window_with_escaped_command() {
        let script = iterm_launch_script("printf \"hello\" && echo \\\\done", Some("EVA-MUX 会话"));
        assert!(script.contains("tell application \"iTerm2\""));
        assert!(script.contains("create window with default profile"));
        assert!(!script.contains("create tab"));
        assert!(script.contains("tell targetSession to write text"));
        assert!(script.contains("set name of targetSession to \"EVA-MUX 会话\""));
        assert!(script.contains("printf \\\"hello\\\" && echo \\\\\\\\done"));
    }

    #[test]
    fn keeps_terminal_as_fallback() {
        let script = terminal_launch_script("codex resume 'abc-123'");
        assert!(script.contains("tell application \"Terminal\""));
        assert!(script.contains("do script \"codex resume 'abc-123'\""));
    }

    #[test]
    fn builds_new_codex_yolo_command() {
        assert_eq!(
            new_codex_yolo_command(Path::new("/tmp/eva mux")),
            "cd '/tmp/eva mux' && codex --yolo"
        );
    }

    #[test]
    fn cleans_terminal_titles() {
        assert_eq!(terminal_title("  EVA-MUX\n会话  "), "EVA-MUX会话");
        assert_eq!(terminal_title("\n\t"), "Codex");
    }
}
