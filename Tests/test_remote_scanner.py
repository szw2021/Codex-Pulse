import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "src" / "remote" / "remote_scanner.py"
SPEC = importlib.util.spec_from_file_location("remote_scanner", SCRIPT_PATH)
REMOTE_SCANNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE_SCANNER)
NOW = 2_000_000_000


def record(outer_type, payload, seconds_ago):
    return json.dumps({
        "timestamp": NOW - seconds_ago,
        "type": outer_type,
        "payload": payload,
    })


def state_for(lines, database_approval):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as rollout:
        rollout.write("\n".join(lines))
        rollout.flush()
        return REMOTE_SCANNER.detect_state(
            rollout.name,
            database_approval,
            7,
            False,
            NOW - 5,
            NOW,
        )[0]


def task_started():
    return record("event_msg", {"type": "task_started"}, 10)


def turn_context(approval):
    return record("turn_context", {"approval_policy": approval}, 9)


def exec_call():
    return record("response_item", {
        "type": "custom_tool_call",
        "call_id": "call-1",
        "name": "exec",
    }, 5)


class RemoteApprovalStateTests(unittest.TestCase):
    def test_persistent_mcp_server_is_not_working_command(self):
        children = {1: [2], 2: []}
        commands = {2: "npm exec apifox-mcp-server@latest --project-id=123"}
        self.assertFalse(REMOTE_SCANNER.has_working_child(1, children, commands))

        children[1].append(3)
        children[3] = [4]
        commands.update({3: "/bin/zsh -lc sleep 30", 4: "/bin/sleep 30"})
        self.assertTrue(REMOTE_SCANNER.has_working_child(1, children, commands))

    def test_current_turn_approval_overrides_stale_database_value(self):
        self.assertEqual(
            state_for([task_started(), turn_context("on-request"), exec_call()], "never"),
            "attention",
        )
        self.assertEqual(
            state_for([task_started(), turn_context("never"), exec_call()], "on-request"),
            "active",
        )

    def test_resolved_authorization_returns_to_active(self):
        output = record("response_item", {
            "type": "custom_tool_call_output",
            "call_id": "call-1",
        }, 2)
        self.assertEqual(
            state_for(
                [task_started(), turn_context("on-request"), exec_call(), output],
                "never",
            ),
            "active",
        )


if __name__ == "__main__":
    unittest.main()
