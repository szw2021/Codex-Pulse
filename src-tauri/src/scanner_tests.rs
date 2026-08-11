use super::*;

const NOW: i64 = 2_000_000_000_000;

fn record(outer: &str, payload: Value, seconds_ago: i64) -> String {
    serde_json::json!({
        "timestamp": chrono::DateTime::from_timestamp_millis(NOW - seconds_ago * 1000).unwrap().to_rfc3339(),
        "type": outer,
        "payload": payload
    })
    .to_string()
}

fn event(name: &str, seconds: i64) -> String {
    record("event_msg", serde_json::json!({"type": name}), seconds)
}

fn turn_context(approval: &str, seconds: i64) -> String {
    record(
        "turn_context",
        serde_json::json!({"approval_policy": approval}),
        seconds,
    )
}

fn completed_item(item: Value, seconds: i64) -> String {
    record(
        "event_msg",
        serde_json::json!({"type": "item_completed", "item": item}),
        seconds,
    )
}

fn detect(
    lines: Vec<String>,
    approval: &str,
    process: Option<ProcessInfo>,
    modified: i64,
) -> String {
    detect_state(
        lines.join("\n").as_bytes(),
        approval,
        process,
        NOW - modified * 1000,
        NOW,
    )
    .state
}

fn idle_process() -> Option<ProcessInfo> {
    Some(ProcessInfo {
        pid: 7,
        has_working_child: false,
    })
}

#[test]
fn detects_turn_states() {
    let working = Some(ProcessInfo {
        pid: 7,
        has_working_child: true,
    });
    assert_eq!(
        detect(vec![event("task_started", 5)], "never", idle_process(), 5),
        "active"
    );
    assert_eq!(
        detect(
            vec![event("task_started", 10), event("task_complete", 1)],
            "on-request",
            idle_process(),
            1
        ),
        "completed"
    );
    let call = record(
        "response_item",
        serde_json::json!({"type":"function_call","call_id":"call-1","name":"exec_command"}),
        5,
    );
    assert_eq!(
        detect(
            vec![event("task_started", 10), call.clone()],
            "on-request",
            idle_process(),
            5
        ),
        "attention"
    );
    assert_eq!(
        detect(
            vec![event("task_started", 10), call],
            "on-request",
            working,
            5
        ),
        "active"
    );
    assert_eq!(
        detect(vec![event("task_started", 30)], "never", None, 30),
        "failed"
    );
}

#[test]
fn current_turn_approval_overrides_stale_database_value() {
    let call = record(
        "response_item",
        serde_json::json!({"type":"custom_tool_call","call_id":"call-1","name":"exec"}),
        5,
    );
    let base = vec![
        event("task_started", 10),
        turn_context("on-request", 9),
        call.clone(),
    ];
    assert_eq!(detect(base, "never", idle_process(), 5), "attention");
    assert_eq!(
        detect(
            vec![event("task_started", 10), turn_context("never", 9), call],
            "on-request",
            idle_process(),
            5
        ),
        "active"
    );
}

#[test]
fn resolved_authorization_call_returns_to_active() {
    let call = record(
        "response_item",
        serde_json::json!({"type":"function_call","call_id":"call-1","name":"request_user_input"}),
        5,
    );
    let output = record(
        "response_item",
        serde_json::json!({"type":"function_call_output","call_id":"call-1"}),
        2,
    );
    assert_eq!(
        detect(
            vec![
                event("task_started", 10),
                turn_context("on-request", 9),
                call,
                output
            ],
            "never",
            idle_process(),
            2
        ),
        "active"
    );
}

#[test]
fn includes_user_threads_from_all_codex_surfaces() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("state_5.sqlite");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                source TEXT NOT NULL,
                thread_source TEXT,
                title TEXT,
                archived INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
    let rows = [
        ("cli", "cli", Some("user"), 0),
        ("desktop", "app", Some("user"), 0),
        ("vscode", "vscode", Some("user"), 0),
        ("legacy", "cli", None, 0),
        ("subagent", r#"{"subagent":{}}"#, Some("subagent"), 0),
        ("archived", "cli", Some("user"), 1),
    ];
    for (id, source, thread_source, archived) in rows {
        connection
            .execute(
                "INSERT INTO threads (id, rollout_path, updated_at, source, thread_source, title, archived)
                 VALUES (?1, ?2, 1, ?3, ?4, '', ?5)",
                params![id, format!("/tmp/{id}.jsonl"), source, thread_source, archived],
            )
            .unwrap();
    }
    drop(connection);

    let ids = query_thread_rows_direct(&database)
        .unwrap()
        .into_iter()
        .map(|row| row.id)
        .collect::<HashSet<_>>();
    assert_eq!(
        ids,
        HashSet::from([
            "cli".to_string(),
            "desktop".to_string(),
            "vscode".to_string(),
            "legacy".to_string(),
        ])
    );
}

#[test]
fn extracts_latest_prompt_and_completion() {
    let input = record(
        "event_msg",
        serde_json::json!({"type":"user_message","message":" 第一行\n第二行 "}),
        9,
    );
    let complete = record(
        "event_msg",
        serde_json::json!({"type":"task_complete","turn_id":"turn-123"}),
        1,
    );
    let result = detect_state(
        [event("task_started", 10), input, complete]
            .join("\n")
            .as_bytes(),
        "never",
        idle_process(),
        NOW - 1000,
        NOW,
    );
    assert_eq!(result.last_prompt.as_deref(), Some("第一行 第二行"));
    assert_eq!(result.completion_token.as_deref(), Some("turn-123"));
}

#[test]
fn extracts_real_activities_from_latest_turn() {
    let old_command = completed_item(
        serde_json::json!({
            "type": "CommandExecution",
            "command": ["/bin/zsh", "-lc", "old command"],
            "status": "completed",
            "exit_code": 0
        }),
        20,
    );
    let prompt = completed_item(
        serde_json::json!({
            "type": "UserMessage",
            "content": [{"type": "text", "text": "优化详情流程"}]
        }),
        10,
    );
    let command = completed_item(
        serde_json::json!({
            "type": "CommandExecution",
            "command": ["/bin/zsh", "-lc", "cargo test"],
            "status": "completed",
            "exit_code": 0
        }),
        5,
    );
    let file_change = completed_item(
        serde_json::json!({
            "type": "FileChange",
            "changes": {"/tmp/app.js": {"type": "update"}},
            "status": "completed"
        }),
        2,
    );
    let activities = extract_activities(
        [old_command, prompt, command, file_change]
            .join("\n")
            .as_bytes(),
    );
    assert_eq!(
        activities
            .iter()
            .map(|item| item.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["prompt", "command", "file"]
    );
    assert_eq!(activities[1].text, "cargo test");
    assert_eq!(activities[2].text, "app.js");
}
