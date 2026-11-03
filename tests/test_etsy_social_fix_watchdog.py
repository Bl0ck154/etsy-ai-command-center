import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "etsy_social_fix_watchdog.py"
SPEC = importlib.util.spec_from_file_location("etsy_social_fix_watchdog", MODULE_PATH)
watchdog = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(watchdog)


class EtsySocialFixWatchdogTests(unittest.TestCase):
    def test_bridge_credentials_load_from_dedicated_unprivileged_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "bridge.env"
            env_file.write_text(
                "SOCIAL_HERMES_API_TOKEN=test-token\n"
                "SOCIAL_HERMES_OWNER_TELEGRAM_ID=owner-1\n",
                encoding="utf-8",
            )
            with mock.patch.object(watchdog, "BRIDGE_ENV_PATH", env_file), mock.patch.dict(
                os.environ,
                {"SOCIAL_HERMES_API_TOKEN": "", "SOCIAL_HERMES_OWNER_TELEGRAM_ID": ""},
                clear=False,
            ):
                self.assertEqual(watchdog.bridge_credentials(), ("test-token", "owner-1"))

    def test_source_is_read_only_and_has_no_queue_mutation_action(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("updateScheduled", source)
        self.assertNotIn("deleteScheduled", source)
        self.assertNotIn("publishDueScheduled", source)
        self.assertNotIn("approval_source", source)

    def test_owner_review_draft_is_healthy_without_future_schedule(self):
        factory = {
            "context_error": None,
            "upcoming": [],
            "owner_review": [{"id": "agent-autonomy-review"}],
            "missing_media": [],
            "overdue": [],
            "autopublish": False,
        }
        queue = {"exit": 0, "active_missing": [], "active_overdue": []}
        with mock.patch.object(watchdog, "load_state", return_value={}):
            self.assertEqual(watchdog.build_human_alert(watchdog.datetime.now(watchdog.timezone.utc), factory, queue), "")

    def test_factory_diag_counts_only_approved_future_posts_as_upcoming(self):
        now = watchdog.datetime.now(watchdog.timezone.utc)
        context = {
            "data": {
                "bridge": {"publish_governance": {"autopublish_enabled": True}},
                "scheduled_posts": [
                    {
                        "id": "agent-autonomy-approved",
                        "status": "approved_scheduled",
                        "approved_for_publish": True,
                        "scheduled_at": (now + watchdog.timedelta(days=1)).isoformat(),
                        "media_items": [{"url": "https://example.test/approved.jpg"}],
                    },
                    {
                        "id": "agent-autonomy-review-scheduled",
                        "status": "scheduled",
                        "approved_for_publish": False,
                        "scheduled_at": (now + watchdog.timedelta(days=1)).isoformat(),
                        "media_items": [{"url": "https://example.test/review.jpg"}],
                    },
                    {
                        "id": "agent-autonomy-stale-history",
                        "status": "scheduled",
                        "approved_for_publish": False,
                        "scheduled_at": (now - watchdog.timedelta(days=1)).isoformat(),
                        "media_items": [{"url": "https://example.test/stale.jpg"}],
                    },
                ],
            },
        }
        with mock.patch.object(watchdog, "bridge_context", return_value=(context, None)):
            result = watchdog.factory_diag(now)

        self.assertEqual([item["id"] for item in result["upcoming"]], ["agent-autonomy-approved"])
        self.assertEqual([item["id"] for item in result["review_scheduled"]], ["agent-autonomy-review-scheduled"])
        self.assertEqual([item["id"] for item in result["stale_history"]], ["agent-autonomy-stale-history"])
        self.assertEqual(result["overdue"], [])

    def test_factory_diag_counts_new_social_hermes_ids_and_deduplicates_legacy_rows(self):
        now = watchdog.datetime.now(watchdog.timezone.utc)
        review = {
            "id": "idea-20260718-ai-creative-plan-owner-review-instagram",
            "source": "social_hermes",
            "status": "draft",
            "approved_for_publish": False,
            "media_items": [{"url": "https://example.test/review.jpg"}],
        }
        context = {
            "data": {
                "bridge": {"publish_governance": {"autopublish_enabled": True}},
                "scheduled_posts": [review, dict(review)],
            },
        }
        with mock.patch.object(watchdog, "bridge_context", return_value=(context, None)):
            result = watchdog.factory_diag(now)

        self.assertEqual([item["id"] for item in result["owner_review"]], [review["id"]])

    def test_live_autopublish_warns_when_only_unapproved_review_items_exist(self):
        factory = {
            "context_error": None,
            "upcoming": [],
            "owner_review": [{"id": "agent-autonomy-review"}],
            "review_scheduled": [{"id": "agent-autonomy-review"}],
            "missing_media": [],
            "overdue": [],
            "stale_history": [{"id": "agent-autonomy-old"}],
            "autopublish": True,
        }
        queue = {"exit": 0, "active_missing": [], "active_overdue": []}
        with mock.patch.object(watchdog, "load_state", return_value={}), mock.patch.object(watchdog, "save_state"):
            alert = watchdog.build_human_alert(watchdog.datetime.now(watchdog.timezone.utc), factory, queue)

        self.assertIn("approved_scheduled", alert)
        self.assertNotIn("stale_history", alert)


if __name__ == "__main__":
    unittest.main()
