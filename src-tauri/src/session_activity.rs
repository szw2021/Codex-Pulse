use std::path::Path;

use chrono::DateTime;
use serde_json::Value;

use crate::models::SessionActivity;

pub(crate) fn extract_activities(data: &[u8]) -> Vec<SessionActivity> {
    const MAX_ACTIVITIES: usize = 24;

    let mut activities = Vec::new();
    for line in String::from_utf8_lossy(data)
        .lines()
        .filter(|line| !line.is_empty())
    {
        let Ok(root) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(activity) = activity_from_record(&root) else {
            continue;
        };
        if activity.kind == "prompt" {
            activities.clear();
        }
        activities.push(activity);
    }
    if activities.len() <= MAX_ACTIVITIES {
        return activities;
    }

    let total = activities.len();
    let tail_count = MAX_ACTIVITIES - 2;
    let omitted = total - 1 - tail_count;
    let marker_timestamp = activities[total - tail_count].timestamp;
    let mut visible = Vec::with_capacity(MAX_ACTIVITIES);
    visible.push(activities[0].clone());
    visible.push(SessionActivity {
        kind: "more".into(),
        label: "省略".into(),
        text: format!("还有 {omitted} 个较早的中间步骤"),
        timestamp: marker_timestamp,
    });
    visible.extend(activities.into_iter().skip(total - tail_count));
    visible
}

fn activity_from_record(root: &Value) -> Option<SessionActivity> {
    let payload = root.get("payload")?;
    if root.get("type").and_then(Value::as_str) != Some("event_msg")
        || payload.get("type").and_then(Value::as_str) != Some("item_completed")
    {
        return None;
    }
    let item = payload.get("item")?;
    let item_type = item.get("type").and_then(Value::as_str)?;
    let timestamp = root
        .get("timestamp")
        .and_then(parse_json_timestamp)
        .or_else(|| {
            payload
                .get("completed_at_ms")
                .and_then(parse_json_timestamp)
        })
        .unwrap_or_default();
    let activity = |kind: &str, label: &str, text: String| SessionActivity {
        kind: kind.into(),
        label: label.into(),
        text,
        timestamp,
    };

    match item_type {
        "UserMessage" => {
            content_text(item.get("content")?, 220).map(|text| activity("prompt", "提问", text))
        }
        "AgentMessage" => {
            let text = content_text(item.get("content")?, 240)?;
            match item.get("phase").and_then(Value::as_str) {
                Some("commentary") => Some(activity("progress", "进展", text)),
                Some("final_answer") => Some(activity("complete", "回复", text)),
                _ => Some(activity("message", "回复", text)),
            }
        }
        "CommandExecution" => {
            let text = command_text(item)?;
            let failed = item
                .get("exit_code")
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0)
                || item.get("status").and_then(Value::as_str) == Some("failed");
            Some(if failed {
                activity("failed", "命令失败", text)
            } else {
                activity("command", "执行命令", text)
            })
        }
        "FileChange" => file_change_text(item).map(|text| {
            let failed = item.get("status").and_then(Value::as_str) == Some("failed");
            if failed {
                activity("failed", "修改失败", text)
            } else {
                activity("file", "修改文件", text)
            }
        }),
        "McpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("MCP");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let title = item
                .get("arguments")
                .and_then(|value| value.get("title"))
                .and_then(Value::as_str);
            let text = title
                .and_then(|value| clean_optional(value, 180))
                .unwrap_or_else(|| clean_string(&format!("{server} · {tool}"), 180));
            let failed = item.get("status").and_then(Value::as_str) == Some("failed");
            Some(if failed {
                activity("failed", "工具失败", text)
            } else {
                activity("tool", "调用工具", text)
            })
        }
        "ImageView" => {
            let path = item.get("path").and_then(Value::as_str)?;
            let name = path
                .trim_start_matches("file://")
                .rsplit('/')
                .next()
                .filter(|value| !value.is_empty())
                .unwrap_or(path);
            Some(activity("image", "查看图片", clean_string(name, 180)))
        }
        "ContextCompaction" => Some(activity(
            "context",
            "整理上下文",
            "压缩较早的会话内容以继续处理".into(),
        )),
        "Reasoning" => item
            .get("summary_text")
            .and_then(|value| content_text(value, 220))
            .map(|text| activity("reasoning", "分析", text)),
        _ => None,
    }
}

fn content_text(value: &Value, limit: usize) -> Option<String> {
    fn collect(value: &Value, parts: &mut Vec<String>) {
        match value {
            Value::String(text) => parts.push(text.clone()),
            Value::Array(items) => {
                for item in items {
                    collect(item, parts);
                }
            }
            Value::Object(object) => {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    parts.push(text.into());
                } else if let Some(content) = object.get("content") {
                    collect(content, parts);
                }
            }
            _ => {}
        }
    }

    let mut parts = Vec::new();
    collect(value, &mut parts);
    clean_optional(&parts.join(" "), limit)
}

fn command_text(item: &Value) -> Option<String> {
    let command = item.get("command")?;
    let text = if let Some(value) = command.as_str() {
        value.to_string()
    } else {
        let parts = command
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        if parts.len() >= 3 && matches!(parts.get(1), Some(&"-c") | Some(&"-lc")) {
            parts.last().copied().unwrap_or_default().to_string()
        } else {
            parts.join(" ")
        }
    };
    clean_optional(&text, 220)
}

fn file_change_text(item: &Value) -> Option<String> {
    let changes = item.get("changes")?.as_object()?;
    if changes.is_empty() {
        return None;
    }
    let names = changes
        .keys()
        .take(4)
        .map(|path| {
            Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(path)
        })
        .collect::<Vec<_>>();
    let suffix = if changes.len() > names.len() {
        format!(" 等 {} 个文件", changes.len())
    } else {
        String::new()
    };
    clean_optional(&format!("{}{}", names.join("、"), suffix), 220)
}

fn parse_json_timestamp(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_f64() {
        return Some(if number > 1e12 {
            number as i64
        } else {
            (number * 1000.0) as i64
        });
    }
    value.as_str().and_then(parse_timestamp)
}

fn parse_timestamp(value: &str) -> Option<i64> {
    if let Ok(number) = value.parse::<f64>() {
        return Some(if number > 1e12 {
            number as i64
        } else {
            (number * 1000.0) as i64
        });
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn clean_string(value: &str, limit: usize) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= limit {
        clean
    } else {
        format!("{}…", clean.chars().take(limit).collect::<String>())
    }
}

fn clean_optional(value: &str, limit: usize) -> Option<String> {
    let clean = clean_string(value, limit);
    (!clean.is_empty()).then_some(clean)
}
