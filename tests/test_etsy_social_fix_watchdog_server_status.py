import importlib.util
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "etsy_social_fix_watchdog.py"
SPEC = importlib.util.spec_from_file_location("etsy_social_fix_watchdog_server_status", MODULE_PATH)
watchdog = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(watchdog)


class EtsySocialFixWatchdogServerStatusTests(unittest.TestCase):
    def test_missing_token_blocks_server_status_request(self):
        with mock.patch.object(watchdog, "bridge_credentials", return_value=("", "")), mock.patch(
            "urllib.request.urlopen"
        ) as urlopen:
            payload, error = watchdog.bridge_context()

        self.assertIsNone(payload)
        self.assertIn("SOCIAL_HERMES_API_TOKEN", error)
        urlopen.assert_not_called()

    def test_api_error_is_reported_as_unavailable_status(self):
        with mock.patch.object(watchdog, "bridge_credentials", return_value=("bridge-token", "owner")), mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            result = watchdog.server_queue_diag(watchdog.datetime.now(watchdog.timezone.utc))

        self.assertFalse(result["ok"])
        self.assertIn("connection refused", result["context_error"])
        self.assertEqual(result["upcoming"], [])
        self.assertEqual(result["queue_summary"], {})

    def test_current_queue_uses_server_scheduler_classifications(self):
        now = watchdog.datetime(2026, 7, 22, 12, 0, tzinfo=watchdog.timezone.utc)
        approved = {
            "id": "agent-autonomy-approved-instagram",
            "source": "social_hermes",
            "status": "approved_scheduled",
            "queue_state": "approved_scheduled",
            "is_publish_approved": True,
            "scheduled_at": "2026-07-23T16:00:00+00:00",
            "media_items": [{"url": "https://example.test/approved.jpg"}],
        }
        review = {
            "id": "agent-autonomy-review-facebook",
            "source": "social_hermes",
            "status": "scheduled",
            "queue_state": "active_scheduled",
            "is_publish_approved": False,
            "scheduled_at": "2026-07-24T16:00:00+00:00",
            "media_items": [{"url": "https://example.test/review.jpg"}],
        }
        due = {
            "id": "agent-autonomy-due-pinterest",
            "source": "social_hermes",
            "status": "approved_scheduled",
            "queue_state": "publishable_due",
            "is_publish_approved": True,
            "scheduled_at": "2026-07-21T16:00:00+00:00",
            "media_items": [{"url": "https://example.test/due.jpg"}],
        }
        stale = {
            "id": "agent-autonomy-stale-facebook",
            "source": "social_hermes",
            "status": "scheduled",
            "queue_state": "stale_overdue",
            "is_publish_approved": False,
            "scheduled_at": "2026-07-20T16:00:00+00:00",
            "media_items": [{"url": "https://example.test/stale.jpg"}],
        }
        context = {
            "success": True,
            "data": {
                "bridge": {"publish_governance": {"autopublish_enabled": True}},
                "queue_summary": {
                    "active_queue": 2,
                    "stale_overdue": 1,
                    "drafts": 0,
                    "total_visible": 4,
                },
                "active_queue_posts": [approved, review],
                "stale_overdue_posts": [stale],
                "scheduled_posts": [approved, review, due, stale],
            },
        }

        with mock.patch.object(watchdog, "bridge_context", return_value=(context, None)):
            result = watchdog.server_queue_diag(now)

        self.assertTrue(result["ok"])
        self.assertTrue(result["autopublish"])
        self.assertEqual([item["id"] for item in result["upcoming"]], [approved["id"]])
        self.assertEqual([item["id"] for item in result["review_scheduled"]], [review["id"]])
        self.assertEqual([item["id"] for item in result["overdue"]], [due["id"]])
        self.assertEqual([item["id"] for item in result["stale_history"]], [stale["id"]])
        self.assertEqual(result["queue_summary"]["active_queue"], 2)

    def test_watchdog_has_no_legacy_phase3_runtime_dependency(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("phase3_autonomy.py", source)
        self.assertNotIn("subprocess", source)
        self.assertNotIn("--show-queue", source)


if __name__ == "__main__":
    unittest.main()
