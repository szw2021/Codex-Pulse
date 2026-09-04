use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::models::Settings;

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn default_settings_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Application Support/Codex Pulse/settings.json")
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Codex Pulse/settings.json")
    }
}

pub fn expand_codex_home(value: &str, home: &Path) -> Result<PathBuf, String> {
    expand_directory_with_label(value, home, "Codex 数据目录")
}

pub fn expand_directory(value: &str, home: &Path) -> Result<PathBuf, String> {
    expand_directory_with_label(value, home, "项目目录")
}

fn expand_directory_with_label(value: &str, home: &Path, label: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label}包含无效字符"));
    }
    let path = if value == "~" {
        home.to_path_buf()
    } else if let Some(relative) = value.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() {
        return Err("请输入绝对路径，或使用 ~/ 开头的路径".into());
    }
    Ok(path)
}

pub fn load(path: &Path) -> Settings {
    let parsed = fs::read_to_string(path)
        .ok()
        .and_then(|data| serde_json::from_str::<Settings>(&data).ok())
        .unwrap_or_default();
    let normalized = parsed.normalize(now_millis());
    let _ = save(path, &normalized);
    normalized
}

pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let data =
        serde_json::to_vec_pretty(settings).map_err(|error| io::Error::other(error.to_string()))?;
    fs::write(&temporary, data)?;
    fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_and_normalizes_settings() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        fs::write(
            &path,
            r#"{
              "windowPinned": true,
              "notchStatusEnabled": true,
              "themeMode": "unexpected",
              "sessionTitleMode": "unexpected",
              "codexHome": "  /tmp/custom-codex  ",
              "displayLimits": {"active": 0, "completedPending": 9, "failed": 2},
              "titleLines": 2
            }"#,
        )
        .unwrap();
        let settings = load(&path);
        assert!(settings.window_pinned);
        assert!(settings.notch_status_enabled);
        assert_eq!(settings.theme_mode, "system");
        assert_eq!(settings.session_title_mode, "prompt");
        assert_eq!(settings.codex_home, "/tmp/custom-codex");
        assert_eq!(settings.display_limits.active, 4);
        assert_eq!(settings.display_limits.completed_pending, 3);
        assert_eq!(settings.display_limits.failed, 2);
        assert_eq!(settings.title_lines, 2);
        assert!(settings.quick_launch_dirs.is_empty());
        assert!(settings.completion_tracking_started_at > 0);
    }

    #[test]
    fn expands_home_and_rejects_relative_codex_paths() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            expand_codex_home("~/custom-codex", home).unwrap(),
            home.join("custom-codex")
        );
        assert!(expand_codex_home("custom-codex", home).is_err());
        assert!(expand_codex_home("/tmp/custom-codex", home).is_ok());
    }

    #[test]
    fn expands_project_directories() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            expand_directory("~/work/eva-mux", home).unwrap(),
            home.join("work/eva-mux")
        );
        assert!(expand_directory("relative/project", home).is_err());
    }
}
