import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


class FakeFastMCP:
    def __init__(self, *args, **kwargs):
        pass

    def tool(self, *args, **kwargs):
        return lambda function: function

    def run(self, *args, **kwargs):
        return None


def load_bridge(profile_home: Path):
    fastmcp = types.ModuleType("mcp.server.fastmcp")
    fastmcp.FastMCP = FakeFastMCP
    server = types.ModuleType("mcp.server")
    server.fastmcp = fastmcp
    mcp = types.ModuleType("mcp")
    mcp.server = server
    source = Path(__file__).parents[1] / "scripts" / "hermes_social_bridge_mcp.py"
    spec = importlib.util.spec_from_file_location("hermes_social_bridge_mcp_under_test", source)
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(
        sys.modules,
        {"mcp": mcp, "mcp.server": server, "mcp.server.fastmcp": fastmcp},
    ), mock.patch.dict(
        os.environ,
        {
            "HERMES_SOCIAL_PROFILE_HOME": str(profile_home),
            "SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS": "true",
        },
    ):
        spec.loader.exec_module(module)
    return module


class HermesSocialBridgeAsyncTests(unittest.TestCase):
    def test_enqueue_returns_immediately_and_deduplicates_same_feedback(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            spawned = []
            bridge._spawn_social_command_worker = lambda job_id: spawned.append(job_id) or {
                "spawned": True,
                "pid": 123,
                "stdout_log": "out.log",
                "stderr_log": "err.log",
            }

            first = bridge.enqueue_social_command("  Прибери   зайвий текст  ")
            second = bridge.enqueue_social_command("прибери зайвий текст")

            self.assertTrue(first["success"])
            self.assertEqual(first["status"], "accepted")
            self.assertTrue(first["async"])
            self.assertFalse(first["deduplicated"])
            self.assertTrue(second["deduplicated"])
            self.assertEqual(len(spawned), 1)
            jobs = list(bridge.SOCIAL_COMMAND_JOB_DIR.glob("socialcmd_*.json"))
            self.assertEqual(len(jobs), 1)
            payload = json.loads(jobs[0].read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "queued")
            self.assertFalse(payload["published"])

    def test_worker_runs_semantic_social_command_and_persists_safe_result(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            bridge._spawn_social_command_worker = lambda job_id: {
                "spawned": True,
                "pid": 456,
                "stdout_log": "out.log",
                "stderr_log": "err.log",
            }
            accepted = bridge.enqueue_social_command("Зроби заголовок яскравішим")
            self.assertTrue(accepted["success"])
            job_path = next(bridge.SOCIAL_COMMAND_JOB_DIR.glob("socialcmd_*.json"))
            job_id = json.loads(job_path.read_text(encoding="utf-8"))["id"]

            fake_module = types.SimpleNamespace(
                social_command=lambda text: {
                    "success": True,
                    "status": "generating",
                    "job_id": "media-job",
                    "published": False,
                    "owner_feedback": text,
                },
                redact=lambda value: value,
            )
            bridge._phase3_module = lambda: (fake_module, None)
            with mock.patch.dict(os.environ, {"SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS": "true"}):
                result = bridge.run_social_command_job(job_id)

            self.assertEqual(result["status"], "completed")
            self.assertFalse(result["published"])
            self.assertFalse(result["result"]["published"])
            self.assertEqual(result["result"]["owner_feedback"], "Зроби заголовок яскравішим")
            self.assertTrue(result["notification"]["skipped"])

    def test_latest_owner_review_maps_exact_campaign_listing_and_media(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            response = {
                "success": True,
                "data": {
                    "owner": {"telegram_user_id": "470201196"},
                    "scheduled_posts": [
                        {
                            "id": "older-record",
                            "source": "social_hermes",
                            "status": "approved_scheduled",
                            "listing_id": "100",
                            "platform": "instagram",
                            "metadata": {
                                "campaign_id": "older-campaign",
                                "owner_review_required": True,
                                "owner_notification_required": True,
                                "owner_notification_delivery": "etsy_manager_telegram_bot_api",
                                "owner_notification_chat_id": "470201196",
                                "owner_notification_text_message_id": 9,
                                "owner_notification_sent_at": "2026-07-22T09:00:00Z",
                            },
                        },
                        {
                            "id": "latest-instagram",
                            "source": "social_hermes",
                            "status": "approved_scheduled",
                            "listing_id": "4316038646",
                            "listing_title": "Custom Memory Video",
                            "platform": "instagram",
                            "caption": "Instagram copy",
                            "media_items": [{"url": "https://example.test/a.jpg", "source": "generated_image"}],
                            "metadata": {
                                "campaign_id": "latest-campaign",
                                "owner_review_required": True,
                                "owner_notification_required": True,
                                "owner_notification_delivery": "etsy_manager_telegram_bot_api",
                                "owner_notification_chat_id": "470201196",
                                "owner_notification_text_message_id": 503,
                                "owner_notification_sent_at": "2026-07-23T06:35:26Z",
                                "media_strategy": {"format": "single", "frames": [{"id": "hero"}]},
                            },
                        },
                        {
                            "id": "latest-pinterest",
                            "source": "social_hermes",
                            "status": "approved_scheduled",
                            "listing_id": "4316038646",
                            "listing_title": "Custom Memory Video",
                            "platform": "pinterest",
                            "caption": "Pinterest copy",
                            "media_items": [{"url": "https://example.test/a.jpg", "source": "generated_image"}],
                            "metadata": {
                                "campaign_id": "latest-campaign",
                                "owner_review_required": True,
                                "owner_notification_required": True,
                                "owner_notification_delivery": "etsy_manager_telegram_bot_api",
                                "owner_notification_chat_id": "470201196",
                                "owner_notification_text_message_id": 503,
                                "owner_notification_sent_at": "2026-07-23T06:35:26Z",
                                "media_strategy": {"format": "single", "frames": [{"id": "hero"}]},
                            },
                        },
                    ],
                },
            }
            bridge._request_json = lambda *args, **kwargs: response

            item = bridge._latest_etsy_manager_owner_review_item()

            self.assertEqual(item["listing_id"], "4316038646")
            self.assertEqual(item["platform"], "all")
            self.assertEqual(item["platforms"], ["instagram", "pinterest"])
            self.assertEqual(item["etsy_manager_campaign_id"], "latest-campaign")
            self.assertEqual(len(item["media"]["media_items"]), 1)
            self.assertEqual(item["platform_captions"]["pinterest"], "Pinterest copy")

    def test_worker_uses_exact_etsy_manager_preview_for_ai_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            bridge._spawn_social_command_worker = lambda job_id: {"spawned": True, "pid": 456}
            accepted = bridge.enqueue_social_command("Прибери умови і слово доставка")
            self.assertTrue(accepted["success"])
            job_path = next(bridge.SOCIAL_COMMAND_JOB_DIR.glob("socialcmd_*.json"))
            job_id = json.loads(job_path.read_text(encoding="utf-8"))["id"]

            state = {
                "queue": [{"id": "stale-local", "status": "planned", "listing_id": ""}],
                "current_social_context": {"item_id": "stale-local"},
            }
            saved_states = []
            revised = []
            fake_module = types.SimpleNamespace(
                load_state=lambda: state,
                apply_runtime_config=lambda value: value,
                current_social_context=lambda value: {
                    "current_preview_item": next(
                        (item for item in value["queue"] if item["id"] == value["current_social_context"]["item_id"]),
                        None,
                    )
                },
                pin_owner_preview_context=lambda value, item, source="": value.update({
                    "current_social_context": {"item_id": item["id"], "source": source}
                }),
                save_state=lambda value: saved_states.append(value),
                find_queue_item=lambda value, item_id: next(
                    (item for item in value["queue"] if item["id"] == item_id),
                    None,
                ),
                bridge_revision_plan=lambda feedback, item: {
                    "success": True,
                    "data": {"intent": "revision", "revision_brief": feedback},
                },
                revise_idea_item=lambda feedback, item_id="", revision_plan=None: revised.append({
                    "feedback": feedback,
                    "item_id": item_id,
                    "plan": revision_plan,
                }) or {
                    "success": True,
                    "status": "generating",
                    "job_id": "media-job",
                    "published": False,
                },
                social_command=lambda text: self.fail("legacy local routing should not handle the exact revision"),
                redact=lambda value: value,
            )
            bridge._phase3_module = lambda: (fake_module, None)
            bridge._owner_telegram_id = lambda: "470201196"
            bridge_calls = []
            live_status = {"value": "approved_scheduled"}

            def fake_request(action, payload=None, method="POST"):
                bridge_calls.append((action, payload, method))
                if action == "updateScheduled":
                    live_status["value"] = "paused"
                    return {"success": True, "action": action, "data": {"id": payload["id"], "status": "paused"}}
                return {
                    "success": True,
                    "data": {
                        "owner": {"telegram_user_id": "470201196"},
                        "scheduled_posts": [{
                        "id": "live-preview",
                        "source": "social_hermes",
                        "status": live_status["value"],
                        "approved_for_publish": live_status["value"] != "paused",
                        "listing_id": "4316038646",
                        "listing_title": "Custom Memory Video",
                        "platform": "pinterest",
                        "caption": "Old copy",
                        "media_items": [{"url": "https://example.test/pin.jpg", "source": "generated_image"}],
                        "metadata": {
                            "campaign_id": "campaign-live",
                            "owner_review_required": True,
                            "owner_notification_required": True,
                            "owner_notification_delivery": "etsy_manager_telegram_bot_api",
                            "owner_notification_chat_id": "470201196",
                            "owner_notification_text_message_id": 503,
                            "owner_notification_sent_at": "2026-07-23T06:35:26Z",
                            "auto_publish_after_review_window": live_status["value"] != "paused",
                            "auto_publish_armed": live_status["value"] != "paused",
                            "media_strategy": {"format": "single", "frames": [{"id": "pin"}]},
                        },
                        }],
                    },
                }

            bridge._request_json = fake_request
            with mock.patch.dict(os.environ, {"SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS": "true"}):
                result = bridge.run_social_command_job(job_id)

            self.assertEqual(result["status"], "completed")
            self.assertEqual(revised[0]["item_id"], "live-preview")
            self.assertEqual(result["result"]["current_preview_source"], "etsy_manager_owner_review_sync")
            self.assertEqual(state["current_social_context"]["item_id"], "live-preview")
            self.assertTrue(saved_states)
            self.assertEqual(
                [call for call in bridge_calls if call[0] == "updateScheduled"],
                [("updateScheduled", {
                    "id": "live-preview",
                    "status": "paused",
                    "owner_revision_in_progress": True,
                    "approved": True,
                    "approved_by": "470201196",
                    "telegram_user_id": "470201196",
                }, "POST")],
            )
            self.assertEqual(result["result"]["superseded_preview"]["updated_count"], 1)
            memory_calls = [call for call in bridge_calls if call[0] == "recordOwnerFeedback"]
            self.assertEqual(len(memory_calls), 1)
            self.assertEqual(memory_calls[0][1]["current_preview"]["listing_id"], "4316038646")
            self.assertEqual(memory_calls[0][1]["revision_plan"]["intent"], "revision")

    def test_worker_cancels_whole_preview_without_legacy_regeneration(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            bridge._spawn_social_command_worker = lambda job_id: {"spawned": True, "pid": 456}
            accepted = bridge.enqueue_social_command("Таке не треба")
            self.assertTrue(accepted["success"])
            job_path = next(bridge.SOCIAL_COMMAND_JOB_DIR.glob("socialcmd_*.json"))
            job_id = json.loads(job_path.read_text(encoding="utf-8"))["id"]
            current = {"id": "current-preview", "status": "idea_preview", "source": "phase3_local_context"}
            state = {"queue": [current]}
            rejected = []
            fake_module = types.SimpleNamespace(
                load_state=lambda: state,
                apply_runtime_config=lambda value: value,
                find_queue_item=lambda value, item_id: next((item for item in value["queue"] if item["id"] == item_id), None),
                bridge_revision_plan=lambda feedback, item: {
                    "success": True,
                    "data": {"intent": "cancel", "rationale": "The owner rejected the whole current proposal."},
                },
                reject_item=lambda item_id, reason="": rejected.append((item_id, reason)) or {
                    "success": True,
                    "status": "rejected",
                    "published": False,
                },
                social_command=lambda text: self.fail("AI-classified cancellation must not enter legacy routing"),
                redact=lambda value: value,
            )
            bridge._phase3_module = lambda: (fake_module, None)
            bridge._resolved_owner_review_item = lambda module: (current, False)
            bridge._notify_social_command_completion = lambda module, result: {"sent": True}

            with mock.patch.dict(os.environ, {"SOCIAL_HERMES_DISABLE_OWNER_NOTIFICATIONS": "true"}):
                result = bridge.run_social_command_job(job_id)

            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["result"]["intent"], "current_context_cancel")
            self.assertEqual(rejected, [("current-preview", "telegram_ai_cancel")])
            self.assertFalse(result["result"]["published"])

    def test_revision_fails_closed_when_exact_scheduled_preview_cannot_be_disarmed(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            bridge._owner_telegram_id = lambda: "470201196"
            bridge._request_json = lambda *args, **kwargs: {
                "success": False,
                "code": "BRIDGE_DOWN",
            }
            item = {
                "source": "etsy_manager_owner_review_sync",
                "etsy_manager_record_ids": ["scheduled-one"],
            }

            result = bridge._disarm_synced_owner_review(item)

            self.assertFalse(result["success"])
            self.assertEqual(result["code"], "CURRENT_PREVIEW_DISARM_VERIFICATION_FAILED")
            self.assertFalse(result["published"])

    def test_disarm_attempts_every_campaign_record_before_failing_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            bridge._owner_telegram_id = lambda: "470201196"
            update_calls = []

            def fake_request(action, payload=None, method="POST"):
                if action == "updateScheduled":
                    update_calls.append(payload["id"])
                    return {"success": payload["id"] == "two"}
                return {
                    "success": True,
                    "data": {
                        "scheduled_posts": [
                            {
                                "id": "one",
                                "status": "approved_scheduled",
                                "approved_for_publish": True,
                                "metadata": {
                                    "auto_publish_after_review_window": True,
                                    "auto_publish_armed": True,
                                },
                            },
                            {
                                "id": "two",
                                "status": "paused",
                                "approved_for_publish": False,
                                "metadata": {
                                    "auto_publish_after_review_window": False,
                                    "auto_publish_armed": False,
                                },
                            },
                        ],
                    },
                }

            bridge._request_json = fake_request
            result = bridge._disarm_synced_owner_review({
                "source": "etsy_manager_owner_review_sync",
                "etsy_manager_record_ids": ["one", "two"],
            })

            self.assertEqual(update_calls, ["one", "two"])
            self.assertFalse(result["success"])
            self.assertEqual(result["code"], "CURRENT_PREVIEW_STILL_PUBLISHABLE")
            self.assertEqual(result["verification"]["unsafe_records"][0]["id"], "one")

    def test_memory_failure_cannot_prevent_disarm_or_current_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            events = []
            bridge._disarm_synced_owner_review = lambda item: events.append("disarm") or {
                "success": True,
                "updated_count": 1,
                "published": False,
            }

            def fail_memory(*args, **kwargs):
                events.append("memory")
                raise RuntimeError("KV unavailable")

            bridge._record_owner_feedback_memory = fail_memory
            module = types.SimpleNamespace(
                revise_idea_item=lambda *args, **kwargs: events.append("revise") or {
                    "success": True,
                    "status": "generating",
                    "published": False,
                }
            )

            result = bridge._apply_owner_revision(
                module,
                "Remove unsupported delivery claims.",
                {"id": "delivered-preview", "source": "etsy_manager_owner_review_sync"},
                {"intent": "revision"},
            )

            self.assertEqual(events, ["disarm", "memory", "revise"])
            self.assertTrue(result["success"])
            self.assertFalse(result["owner_feedback_memory"]["success"])
            self.assertEqual(result["owner_feedback_memory"]["code"], "RuntimeError")

    def test_verified_delivered_preview_beats_newer_undelivered_local_state(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            local = {
                "id": "newer-local",
                "listing_id": "local-listing",
                "updated_at": "2026-07-23T12:00:00Z",
            }
            delivered = {
                "id": "delivered-preview",
                "listing_id": "delivered-listing",
                "owner_notification_sent_at": "2026-07-23T11:00:00Z",
                "source": "etsy_manager_owner_review_sync",
            }
            bridge._current_phase3_item = lambda module: (local, {})
            bridge._latest_etsy_manager_owner_review_item = lambda: delivered
            bridge._pin_etsy_manager_owner_review = lambda module, item: item

            current, synced = bridge._resolved_owner_review_item(object())

            self.assertTrue(synced)
            self.assertEqual(current["id"], "delivered-preview")

    def test_owner_review_sync_rejects_unverified_or_cross_listing_campaign(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            base_metadata = {
                "campaign_id": "mixed-campaign",
                "owner_review_required": True,
                "owner_notification_required": True,
                "owner_notification_delivery": "etsy_manager_telegram_bot_api",
                "owner_notification_chat_id": "470201196",
                "owner_notification_text_message_id": 503,
                "owner_notification_sent_at": "2026-07-23T06:35:26Z",
            }
            bridge._request_json = lambda *args, **kwargs: {
                "success": True,
                "data": {
                    "owner": {"telegram_user_id": "470201196"},
                    "scheduled_posts": [
                        {
                            "id": "one",
                            "source": "social_hermes",
                            "status": "approved_scheduled",
                            "listing_id": "111",
                            "metadata": dict(base_metadata),
                        },
                        {
                            "id": "two",
                            "source": "social_hermes",
                            "status": "approved_scheduled",
                            "listing_id": "222",
                            "metadata": dict(base_metadata),
                        },
                    ],
                },
            }

            self.assertIsNone(bridge._latest_etsy_manager_owner_review_item())

    def test_concurrent_duplicate_feedback_spawns_exactly_one_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            spawned = []
            spawn_lock = bridge.threading.Lock()

            def fake_spawn(job_id):
                with spawn_lock:
                    spawned.append(job_id)
                return {"spawned": True, "pid": 789}

            bridge._spawn_social_command_worker = fake_spawn
            with ThreadPoolExecutor(max_workers=12) as executor:
                results = list(executor.map(
                    lambda _: bridge.enqueue_social_command("Прибери технічний текст"),
                    range(24),
                ))

            self.assertEqual(len(spawned), 1)
            self.assertEqual(sum(not item["deduplicated"] for item in results), 1)
            self.assertTrue(all(item["success"] for item in results))

    def test_legacy_approval_and_queue_mutating_e2e_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = load_bridge(Path(directory))
            self.assertEqual(bridge.phase3_approve("item-1")["code"], "OWNER_APPROVAL_REQUIRED")
            self.assertEqual(bridge.phase3_live_safe_e2e()["code"], "PRODUCTION_E2E_DISABLED")
            self.assertEqual(bridge.idea_intake_e2e()["code"], "PRODUCTION_E2E_DISABLED")
            self.assertEqual(bridge._dry_e2e()["code"], "PRODUCTION_E2E_DISABLED")


if __name__ == "__main__":
    unittest.main()
