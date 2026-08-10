use std::process::{Command, Stdio};

use crate::models::Session;

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn apple_script_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

pub fn resume_command(session: &Session, yolo_enabled: bool) -> String {
    let mode = if yolo_enabled {
        " --dangerously-bypass-approvals-and-sandbox"
    } else {
        ""
    };
    format!(
        "cd {} && codex resume{} {}",
        shell_quote(&session.cwd),
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

pub fn launch_terminal(command: &str) -> Result<(), String> {
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        apple_script_string(command)
    );
    Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开终端：{error}"))
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
            resume_command(&local, false),
            "cd '/tmp/demo folder' && codex resume 'abc-123'"
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
        assert!(yolo_command.contains("--resume '\\''remote-123'\\'' --dangerously-skip-permissions"));
    }
}
