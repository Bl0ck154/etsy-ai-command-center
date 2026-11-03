import sys
import unittest
import datetime as dt
import json
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import social_autonomous_content_factory as factory


def review_card_design():
    return {
        "style": "modern_poster",
        "heading": "What an Etsy buyer said",
        "highlight_phrase": "looked natural",
        "background_color": "#DDEFE7",
        "surface_color": "#FFFDF8",
        "text_color": "#17251F",
        "accent_color": "#E85D3F",
    }


class SocialAutonomousContentFactorySecretTests(unittest.TestCase):
    def test_factory_never_reads_privileged_app_env_through_sudo(self):
        source = Path(factory.__file__).read_text(encoding="utf-8")

        self.assertNotIn("sudo_env", source)
        self.assertNotIn('subprocess.check_output(["sudo"', source)
        self.assertNotIn("import subprocess", source)


class SocialAutonomousContentFactoryMediaTests(unittest.TestCase):
    def setUp(self):
        self.listing = {
            "title": "Custom Pet Portrait",
            "image_url": "https://img.example.test/first-listing-image.jpg",
        }

    def test_accepts_ai_selected_two_frame_instagram_carousel(self):
        variant = {
            "carousel": True,
            "media_items": [
                {
                    "url": "https://img.example.test/listing-example.jpg",
                    "source": "listing_image",
                },
                {
                    "url": "https://manager.example.test/media/generated-context.png",
                    "source": "generated_image",
                    "permanent": True,
                    "checksum_sha256": "a" * 64,
                },
            ],
        }

        media = factory.build_media_payloads_from_plan(
            variant, self.listing, "instagram"
        )

        self.assertEqual(len(media), 2)
        self.assertEqual(
            [item["source"] for item in media],
            ["listing_image", "generated_image"],
        )

    def test_instagram_carousel_metadata_uses_ai_selected_format(self):
        self.assertTrue(factory.variant_is_instagram_carousel(
            {"format": "carousel"},
            "instagram",
        ))
        self.assertTrue(factory.variant_is_instagram_carousel(
            {"carousel": True},
            "instagram",
        ))
        self.assertFalse(factory.variant_is_instagram_carousel(
            {"format": "single"},
            "instagram",
        ))
        self.assertFalse(factory.variant_is_instagram_carousel(
            {"format": "carousel"},
            "pinterest",
        ))

    def test_blocked_plan_reports_contract_issues_instead_of_positive_rationale(self):
        plan = {
            "status": "blocked_campaign_visual_quality",
            "generation_decision": {
                "rationale": "Approve this package.",
            },
            "campaign_quality_review": {
                "rationale": "Approve this package.",
                "blocking_reasons": [
                    "pinterest: standalone image is not strong enough to carry the post by itself",
                ],
            },
        }

        error = factory.creative_plan_blocking_error(plan)

        self.assertIn("standalone image is not strong enough", error)
        self.assertNotIn("Approve this package", error)

    def test_blocked_plan_includes_rejected_media_revision_diagnostics(self):
        error = factory.creative_plan_blocking_error(
            {"status": "blocked_campaign_visual_quality"},
            "media generation exhausted",
            [{
                "brief_id": "frame_source_to_result",
                "rejected_previews": [{
                    "specific_revision": "Keep every source photo fully inside the canvas with safe margins.",
                }],
            }],
        )

        self.assertIn("Rejected media diagnostics", error)
        self.assertIn("frame_source_to_result", error)
        self.assertIn("safe margins", error)

    def test_preserves_generated_media_quality_evidence_for_owner_review(self):
        review = {
            "decision": "approve",
            "approved": True,
            "rationale": "The generated pixels faithfully support the selected campaign.",
            "model": "vision-review-model",
            "run_id": "vision-run-1",
        }
        media = factory.build_media_payloads_from_plan({
            "media_items": [{
                "url": "https://manager.example.test/api/social?action=mediaAsset&id=shmedia_approved",
                "source": "generated_image",
                "permanent": True,
                "checksum_sha256": "a" * 64,
                "quality_review": review,
                "generated_via": "external_ai",
                "image_model_tier": "standard",
            }],
        }, self.listing, "facebook")

        self.assertEqual(media[0]["quality_review"], review)
        self.assertEqual(media[0]["generated_via"], "external_ai")
        self.assertEqual(media[0]["image_model_tier"], "standard")

    def test_pinterest_requires_one_ai_selected_pin_asset(self):
        variant = {
            "media_items": [
                {"url": "https://img.example.test/one.jpg", "source": "listing_image"},
                {"url": "https://img.example.test/two.jpg", "source": "listing_image"},
            ],
        }

        self.assertEqual(
            factory.build_media_payloads_from_plan(variant, self.listing, "pinterest"),
            [],
        )

    def test_ai_strategy_rejects_pinterest_carousel_for_make_route(self):
        plan = {
            "media_strategy": {
                "format": "carousel",
                "target_media_count": 2,
                "required_visible_evidence": "Show the buyer value clearly.",
                "frame_count_rationale": "Two frames are enough to test the invalid Pinterest carousel contract.",
                "frames": [
                    {
                        "id": "one",
                        "communication_goal": "Lead",
                        "visible_buyer_evidence": "Visible result",
                        "evidence_strength": "primary",
                        "source": "listing_image",
                        "reference_media_rank": 1,
                    },
                    {
                        "id": "two",
                        "communication_goal": "Support",
                        "visible_buyer_evidence": "Useful detail",
                        "evidence_strength": "supporting",
                        "source": "listing_image",
                        "reference_media_rank": 2,
                    },
                ],
                "platform_variants": {
                    "pinterest": {
                        "format": "carousel",
                        "frame_ids": ["one", "two"],
                        "buyer_evidence_frame_ids": ["one"],
                    },
                },
            },
        }

        self.assertIn(
            "exactly one frame",
            factory.ai_media_strategy_problem(plan, ["pinterest"]),
        )

    def test_quality_replan_keeps_already_approved_persistent_frames(self):
        approved = [{
            "id": "shmedia_approved",
            "brief_id": "hook",
            "url": "https://manager.example.test/api/social?action=mediaAsset&id=shmedia_approved",
            "permanent": True,
            "checksum_sha256": "a" * 64,
            "quality_review": {"decision": "approve", "approved": True},
        }]
        plan_body = {"generated_media": [], "context": {}}

        factory.preserve_approved_media_for_replan(plan_body, approved)

        self.assertEqual(plan_body["generated_media"], approved)

    def test_generated_media_merge_keeps_later_success_and_replaces_same_brief(self):
        existing = [{
            "id": "old",
            "brief_id": "hero",
            "url": "https://manager.example.test/media/old.png",
        }]
        later_batch = [
            {
                "id": "support",
                "brief_id": "support",
                "url": "https://manager.example.test/media/support.png",
            },
            {
                "id": "new",
                "brief_id": "hero",
                "url": "https://manager.example.test/media/new.png",
            },
        ]

        merged = factory.merge_generated_media_by_brief(existing, later_batch)

        self.assertEqual([item["brief_id"] for item in merged], ["hero", "support"])
        self.assertEqual(merged[0]["id"], "new")

    def test_ai_discard_decision_removes_only_the_named_accepted_asset(self):
        media = [
            {"brief_id": "hero", "url": "https://manager.example.test/hero.png"},
            {"brief_id": "support", "url": "https://manager.example.test/support.png"},
        ]
        plan = {
            "media_strategy": {
                "accepted_asset_decisions": [
                    {"brief_id": "hero", "decision": "reuse", "rationale": "Strong lead."},
                    {"brief_id": "support", "decision": "discard", "rationale": "No longer needed."},
                ],
            },
        }

        self.assertEqual(
            factory.reconcile_generated_media_with_ai_decisions(media, plan),
            [media[0]],
        )

    def test_explicit_discard_can_clear_replan_media_context(self):
        plan_body = {"generated_media": [{"brief_id": "old"}], "context": {}}

        factory.preserve_approved_media_for_replan(plan_body, [])

        self.assertEqual(plan_body["generated_media"], [])

    def test_generation_resolution_carries_accepted_assets_and_failure_ledger(self):
        approved = [{"brief_id": "hero", "url": "https://manager.example.test/hero.png"}]
        failed = [{
            "brief_id": "support",
            "attempts": 2,
            "outcome": "generate_media_timeout",
            "error": "timed out",
        }]
        plan_body = {"generated_media": [], "context": {}}

        factory.update_generation_resolution_context(
            plan_body,
            approved,
            failed,
            2,
            2,
            {"attempted": True, "resolved": False},
        )

        self.assertEqual(plan_body["generated_media"], approved)
        self.assertEqual(
            plan_body["context"]["media_generation_resolution"],
            {
                "phase": "post_generation_replan",
                "generation_round": 2,
                "generation_round_limit": 2,
                "remaining_generation_rounds": 0,
                "generation_budget_exhausted": True,
                "failed_or_exhausted_briefs": failed,
                "prior_campaign_quality_repair": {
                    "attempted": True,
                    "resolved": False,
                    "consumed_after_generation_round": 2,
                },
            },
        )

    def test_failure_ledger_deduplicates_brief_and_preserves_attempt_count(self):
        first = factory.generation_failure_fact(
            {"code": "MEDIA_QUALITY_REJECTED", "error": "weak evidence"},
            {"id": "hero", "role": "lead"},
            1,
        )
        second = factory.generation_failure_fact(
            {"code": "GENERATE_MEDIA_TIMEOUT", "error": "timed out"},
            {"id": "hero", "role": "lead"},
            2,
        )

        merged = factory.merge_generation_failures([first], [second])

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["brief_id"], "hero")
        self.assertEqual(merged[0]["attempts"], 2)
        self.assertEqual(merged[0]["outcome"], "generate_media_timeout")
        self.assertRegex(merged[0]["brief_fingerprint_sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(merged[0]["failed_brief"]["role"], "lead")

    def test_rejected_preview_diagnostics_survive_a_later_successful_repair(self):
        rejected = factory.generation_failure_fact(
            {
                "code": "MEDIA_QUALITY_REJECTED",
                "error": "The output is visually ambiguous.",
                "data": {
                    "rejected_previews": [{
                        "id": "shmedia-rejected",
                        "url": "https://manager.example.test/api/social?action=mediaAsset&id=shmedia-rejected",
                        "source": "quality_rejected_preview",
                        "quality_review": {
                            "decision": "regenerate",
                            "owner_summary_uk": (
                                "Телефон виглядає як статичне фото, "
                                "а не як готове відео."
                            ),
                            "rationale": "The phone looks like a static photo.",
                            "issues": ["The advertised video result is not visible."],
                            "specific_revision": "Show an unmistakable finished montage.",
                        },
                    }],
                },
            },
            {"id": "hero", "role": "Instagram transformation hero"},
            1,
        )

        diagnostics = factory.merge_generation_diagnostics([], [rejected])
        current_failures = factory.merge_generation_failures([], [rejected])
        accepted_ids = {"hero"}
        current_failures = [
            item for item in current_failures
            if item.get("brief_id") not in accepted_ids
        ]

        self.assertEqual(current_failures, [])
        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(
            diagnostics[0]["rejected_previews"][0]["id"],
            "shmedia-rejected",
        )
        self.assertFalse(
            diagnostics[0]["rejected_previews"][0]["publishable"]
        )
        self.assertEqual(
            diagnostics[0]["rejected_previews"][0]["issues"],
            ["The advertised video result is not visible."],
        )
        self.assertEqual(
            diagnostics[0]["rejected_previews"][0]["owner_summary_uk"],
            "Телефон виглядає як статичне фото, а не як готове відео.",
        )

    def test_generation_request_fingerprint_changes_only_with_execution_contract(self):
        brief = {"id": "hero", "role": "lead"}
        payload = {
            "brief_id": "hero",
            "prompt": "Show the finished transformation clearly.",
            "aspect_ratio": "4:5",
            "reference_required": False,
        }

        first = factory.generation_request_fingerprint(brief, payload)
        identical = factory.generation_request_fingerprint(
            {**brief, "unrelated_debug": "ignored"},
            {**payload, "count": 1, "alt": "ignored operational copy"},
        )
        revised = factory.generation_request_fingerprint(
            brief,
            {**payload, "prompt": "Show distinct source photos becoming one finished portrait."},
        )

        self.assertEqual(first, identical)
        self.assertNotEqual(first, revised)
        self.assertRegex(first, r"^[a-f0-9]{64}$")

    def test_failure_ledger_refreshes_recent_brief_before_bounded_trim(self):
        existing = [
            {"brief_id": f"brief-{index}", "attempts": 1, "outcome": "failed"}
            for index in range(12)
        ]

        merged = factory.merge_generation_failures(existing, [{
            "brief_id": "brief-0",
            "attempts": 2,
            "outcome": "failed_again",
        }, {
            "brief_id": "brief-new",
            "attempts": 1,
            "outcome": "failed",
        }])

        self.assertEqual(len(merged), 12)
        self.assertNotIn("brief-1", [item["brief_id"] for item in merged])
        self.assertEqual(merged[-2]["brief_id"], "brief-0")
        self.assertEqual(merged[-1]["brief_id"], "brief-new")

    def test_mixed_batch_retains_successes_after_an_earlier_rejection(self):
        requests = [
            ({"id": "rejected", "role": "lead"}, {"brief_id": "rejected"}),
            ({"id": "approved", "role": "proof"}, {"brief_id": "approved"}),
            ({
                "id": "review",
                "role": "evidence",
                "renderer": "review_card",
                "review_evidence": {"review_id": "review-42"},
                "context_note": "Custom digital family photo composition service",
                "review_card_design": review_card_design(),
                "aspect_ratio": "1:1",
                "render_spec_sha256": "c" * 64,
            }, {"brief_id": "review"}),
        ]
        responses = [
            {
                "success": False,
                "code": "MEDIA_QUALITY_REJECTED",
                "error": "Lead does not show the service result.",
                "data": {
                    "quality_reviews": [{
                        "decision": "regenerate",
                        "rationale": "Buyer evidence is missing.",
                        "issues": ["No visible result."],
                        "specific_revision": "Show the completed result clearly.",
                    }],
                },
            },
            {
                "success": True,
                "data": {
                    "images": [{
                        "id": "shmedia_approved",
                        "source": "generated_image",
                        "url": "https://manager.example.test/media/approved.png",
                        "permanent": True,
                        "checksum_sha256": "a" * 64,
                        "quality_review": {"decision": "approve", "approved": True},
                    }],
                },
            },
            {
                "success": True,
                "data": {
                    "images": [{
                        "id": "shmedia_review",
                        "source": "review_card",
                        "url": "https://manager.example.test/media/review.png",
                        "permanent": True,
                        "checksum_sha256": "b" * 64,
                    }],
                },
            },
        ]

        approved, feedback, failures = factory.collect_generation_batch_outcomes(
            requests,
            responses,
            {"rejected": 2, "approved": 1, "review": 1},
        )

        self.assertEqual(
            [item["brief_id"] for item in approved],
            ["approved", "review"],
        )
        self.assertEqual([item["brief_id"] for item in feedback], ["rejected"])
        self.assertEqual([item["brief_id"] for item in failures], ["rejected"])
        self.assertEqual(failures[0]["attempts"], 2)
        self.assertEqual(approved[1]["review_id"], "review-42")
        self.assertEqual(approved[1]["review_card_design"], review_card_design())
        self.assertEqual(approved[1]["aspect_ratio"], "1:1")
        self.assertEqual(approved[1]["render_spec_sha256"], "c" * 64)

    def test_generation_worker_exception_becomes_one_failed_batch_result(self):
        requests = [
            ({"id": "broken"}, {"brief_id": "broken"}),
            ({"id": "working"}, {"brief_id": "working"}),
        ]

        def fake_bridge(action, body=None, method="POST", timeout=40):
            if body["brief_id"] == "broken":
                raise ValueError("invalid provider JSON")
            return {"success": True, "brief_id": body["brief_id"]}

        responses = factory.execute_generation_requests(
            requests,
            bridge_fn=fake_bridge,
            concurrency=2,
        )

        self.assertEqual(responses[0]["code"], "bridge_execution_exception")
        self.assertEqual(responses[1]["brief_id"], "working")

    def test_bounded_bridge_retry_recovers_after_planning_exception(self):
        calls = []

        def fake_bridge(action, body=None, method="POST", timeout=40):
            calls.append((action, timeout))
            if len(calls) == 1:
                raise ValueError("invalid planning JSON")
            return {"success": True, "data": {"status": "ready_for_review"}}

        response = factory.bridge_with_bounded_retry(
            "creativePlan",
            {"listing": {"listing_id": "42"}},
            timeout=90,
            attempts=2,
            bridge_fn=fake_bridge,
        )

        self.assertTrue(response["success"])
        self.assertEqual(calls, [("creativePlan", 90), ("creativePlan", 90)])

    def test_bounded_bridge_retry_reports_final_exception(self):
        def fake_bridge(action, body=None, method="POST", timeout=40):
            raise ValueError("invalid planning JSON")

        response = factory.bridge_with_bounded_retry(
            "creativePlan",
            {},
            timeout=90,
            attempts=2,
            bridge_fn=fake_bridge,
        )

        self.assertFalse(response["success"])
        self.assertEqual(response["code"], "bridge_execution_exception")
        self.assertIn("invalid planning JSON", response["error"])

    def test_provider_executes_only_pending_storyboard_briefs(self):
        plan = {
            "generated_frame_briefs": [
                {"id": "accepted_hook", "prompt": "Reuse the accepted hook."},
                {"id": "new_support", "prompt": "Create a new support frame."},
            ],
            "storyboard": [
                {"frame_id": "accepted_hook", "status": "ready", "media": {"brief_id": "accepted_hook"}},
                {"frame_id": "new_support", "brief_id": "new_support", "status": "pending_generation"},
            ],
        }

        self.assertEqual(
            factory.pending_generation_briefs(plan),
            [{"id": "new_support", "prompt": "Create a new support frame."}],
        )

    def test_generated_briefs_run_with_bounded_concurrency_and_keep_ai_order(self):
        lock = threading.Lock()
        active = 0
        max_active = 0
        seen_timeouts = []
        requests = [
            ({"id": brief_id}, {"brief_id": brief_id})
            for brief_id in ("first", "second", "third")
        ]

        def fake_bridge(action, body=None, method="POST", timeout=40):
            nonlocal active, max_active
            self.assertEqual(action, "generateMedia")
            with lock:
                active += 1
                max_active = max(max_active, active)
                seen_timeouts.append(timeout)
            time.sleep({"first": 0.04, "second": 0.01, "third": 0.01}[body["brief_id"]])
            with lock:
                active -= 1
            return {"success": True, "brief_id": body["brief_id"]}

        responses = factory.execute_generation_requests(
            requests,
            bridge_fn=fake_bridge,
            concurrency=2,
        )

        self.assertEqual(max_active, 2)
        self.assertEqual(seen_timeouts, [factory.GENERATE_MEDIA_TIMEOUT_SECONDS] * 3)
        self.assertEqual(
            [response["brief_id"] for response in responses],
            ["first", "second", "third"],
        )

    def test_generated_brief_concurrency_is_clamped_to_one_through_three(self):
        self.assertEqual(factory.bounded_generate_media_concurrency(0), 1)
        self.assertEqual(factory.bounded_generate_media_concurrency(2), 2)
        self.assertEqual(factory.bounded_generate_media_concurrency(99), 3)

    def test_preserves_ai_selected_platforms_without_all_platform_fallback(self):
        response = {
            "data": {
                "opportunities": [{
                    "priority": 91,
                    "moment": "AI-selected buyer moment",
                    "suggested_platforms": ["pinterest", "instagram", "pinterest", "unsupported"],
                    "platform_decisions": {
                        "pinterest": {"decision": "include", "rationale": "Strong visual discovery fit."},
                        "instagram": {"decision": "include", "rationale": "Carousel can explain the result."},
                        "facebook": {"decision": "exclude", "rationale": "No distinct community angle."},
                    },
                    "listing_candidates": [{"listing_id": "listing-42"}],
                }]
            }
        }

        by_listing, ordered = factory.content_opportunity_candidates(response)

        self.assertEqual(by_listing["listing-42"]["suggested_platforms"], ["pinterest", "instagram"])
        self.assertEqual(ordered[0]["suggested_platforms"], ["pinterest", "instagram"])
        self.assertEqual(
            by_listing["listing-42"]["platform_decisions"]["facebook"]["decision"],
            "exclude",
        )

    def test_missing_ai_platform_selection_stays_empty(self):
        response = {
            "data": {
                "opportunities": [{
                    "priority": 70,
                    "listing_candidates": [{"listing_id": "listing-7"}],
                }]
            }
        }

        by_listing, _ = factory.content_opportunity_candidates(response)

        self.assertEqual(by_listing["listing-7"]["suggested_platforms"], [])

    def test_missing_etsy_manager_platform_config_has_no_local_defaults(self):
        self.assertEqual(factory.configured_platforms({}), [])
        self.assertEqual(
            factory.configured_platforms({
                "social_config_summary": {
                    "configured_platforms": ["pinterest", "instagram", "pinterest", "unsupported"]
                }
            }),
            ["pinterest", "instagram"],
        )

    def test_factory_has_no_self_approval_or_local_schedule_branch(self):
        source = Path(factory.__file__).read_text(encoding="utf-8")

        self.assertNotIn("SOCIAL_FACTORY_APPROVE_SCHEDULED", source)
        self.assertNotIn('bridge("schedule"', source)
        self.assertNotIn("schedule_time_for", source)
        self.assertIn('bridge("saveReviewDraft"', source)
        self.assertIn('bridge("deliverReviewNotification"', source)
        self.assertLess(source.index('bridge("saveReviewDraft"'), source.index('bridge("deliverReviewNotification"'))
        self.assertNotIn('bridge("confirmReviewNotification"', source)
        self.assertNotIn("TELEGRAM_BOT_TOKEN", source)
        self.assertNotIn('payload["metadata"]["owner_notification_sent_at"]', source)
        self.assertIn('"require_campaign_visual_quality_review": True', source)
        self.assertIn('"require_current_listing_facts": True', source)
        self.assertIn('"current_listing_availability": plan.get("current_listing_availability")', source)
        self.assertIn('"listing_understanding": plan.get("listing_understanding")', source)
        self.assertIn('SOCIAL_FACTORY_MEDIA_GENERATION_ROUNDS", "3"', source)
        self.assertIn('"crop_focus": str(', source)
        self.assertIn('"media_strategy": plan.get("media_strategy")', source)
        self.assertIn('"ai_campaign_visual_quality_review": plan.get("campaign_quality_review")', source)

    def test_owner_feedback_memory_reaches_every_autonomous_ai_planning_stage(self):
        source = Path(factory.__file__).read_text(encoding="utf-8")

        self.assertIn(
            'owner_feedback_memory = data.get("owner_feedback_memory")',
            source,
        )
        self.assertGreaterEqual(
            source.count('"owner_feedback_memory": owner_feedback_memory'),
            3,
        )

    def test_stale_unapproved_schedule_does_not_block_listing_cooldown(self):
        self.assertFalse(factory.record_counts_for_cooldown({
            "status": "scheduled",
            "is_stale": True,
            "approved_for_publish": False,
        }))

    def test_only_recent_owner_review_drafts_count_toward_target(self):
        now = dt.datetime(2026, 7, 15, 9, 0, tzinfo=dt.timezone.utc)
        recent = {
            "status": "draft",
            "approved_for_publish": False,
            "created_at": (now - dt.timedelta(days=1)).isoformat(),
        }
        stale = {
            **recent,
            "created_at": (now - dt.timedelta(days=factory.OWNER_REVIEW_FRESH_DAYS + 1)).isoformat(),
        }
        self.assertTrue(factory.owner_review_counts_toward_target(recent, now))
        self.assertFalse(factory.owner_review_counts_toward_target(stale, now))

    def test_rejects_carousel_below_two_frame_platform_minimum(self):
        variant = {
            "carousel": True,
            "media_items": [
                {
                    "url": "https://img.example.test/only-frame.jpg",
                    "source": "listing_image",
                }
            ],
        }

        media = factory.build_media_payloads_from_plan(
            variant, self.listing, "instagram"
        )

        self.assertEqual(media, [])

    def test_preserves_ai_selected_media_count_without_local_truncation(self):
        variant = {
            "format": "multi_image",
            "media_items": [
                {
                    "url": f"https://img.example.test/selected-{index}.jpg",
                    "source": "listing_image",
                }
                for index in range(6)
            ]
        }

        media = factory.build_media_payloads_from_plan(
            variant, self.listing, "facebook"
        )

        self.assertEqual(len(media), 6)

    def test_fails_closed_instead_of_removing_an_invalid_planned_frame(self):
        variant = {
            "carousel": True,
            "media_items": [
                {
                    "url": "https://img.example.test/listing-example.jpg",
                    "source": "listing_image",
                },
                {
                    "url": "https://manager.example.test/media/not-persistent.png",
                    "source": "generated_image",
                    "permanent": True,
                },
                {
                    "url": "https://img.example.test/listing-detail.jpg",
                    "source": "listing_image",
                },
            ],
        }

        media = factory.build_media_payloads_from_plan(
            variant, self.listing, "instagram"
        )

        self.assertEqual(media, [])

    def test_does_not_infer_listing_source_when_ai_omits_source(self):
        variant = {
            "media_items": [
                {"url": "https://img.example.test/ai-did-not-select-source.jpg"}
            ]
        }

        media = factory.build_media_payloads_from_plan(
            variant, self.listing, "facebook"
        )

        self.assertEqual(media, [])

    def test_generation_without_reference_does_not_use_first_listing_image(self):
        brief = {
            "id": "context",
            "role": "ordering context",
            "prompt": "Show a buyer choosing a pet photo for a portrait.",
            "image_model": "antigravity/gemini-3.1-flash-image",
            "aspect_ratio": "4:5",
            "reference_required": False,
            "reference_policy": "Planner fallback that must not be forwarded.",
        }
        strategy_frame = {
            "id": "context",
            "source": "generated_image",
            "image_model": "antigravity/gemini-3.1-flash-image",
            "reference_required": False,
        }

        payload, problem = factory.build_generation_payload_from_ai_brief(
            brief, strategy_frame, "", self.listing["title"]
        )

        self.assertEqual(problem, "")
        self.assertIsNotNone(payload)
        self.assertNotIn("reference_image_url", payload)
        self.assertNotIn("reference_policy", payload)
        self.assertTrue(payload["require_visual_quality_review"])
        self.assertEqual(payload["quality_context"]["frame_role"], "ordering context")
        self.assertEqual(payload["model"], "antigravity/gemini-3.1-flash-image")

    def test_persistence_fields_use_only_ai_selected_primary_media(self):
        generated = factory.selected_primary_media_fields(
            [
                {
                    "url": "https://manager.example.test/media/ai-selected.png",
                    "source": "generated_image",
                }
            ]
        )
        selected_listing = factory.selected_primary_media_fields(
            [
                {
                    "url": "https://img.example.test/ai-selected-second-listing-image.jpg",
                    "source": "listing_image",
                }
            ]
        )

        self.assertEqual(generated["listing_image_url"], "")
        self.assertEqual(
            generated["generated_image_url"],
            "https://manager.example.test/media/ai-selected.png",
        )
        self.assertEqual(
            selected_listing["listing_image_url"],
            "https://img.example.test/ai-selected-second-listing-image.jpg",
        )

    def test_generated_media_requires_explicit_ai_visual_quality_approval(self):
        base = {
            "url": "https://manager.example.test/api/social?action=mediaAsset&id=shmedia_approved",
            "source": "generated_image",
            "permanent": True,
            "checksum_sha256": "a" * 64,
        }

        self.assertFalse(factory.generated_media_has_approved_ai_quality(base))
        self.assertFalse(factory.generated_media_has_approved_ai_quality({
            **base,
            "quality_review": {"decision": "regenerate", "approved": False},
        }))
        self.assertTrue(factory.generated_media_has_approved_ai_quality({
            **base,
            "quality_review": {"decision": "approve", "approved": True},
        }))

    def test_accepts_persistent_review_card_before_campaign_ai_review(self):
        review_card = {
            "source": "review_card",
            "url": "https://manager.example.test/api/social?action=mediaAsset&id=shmedia_review",
            "permanent": True,
            "checksum_sha256": "b" * 64,
        }

        self.assertTrue(factory.generated_media_has_approved_ai_quality(review_card))
        self.assertFalse(factory.generated_media_has_approved_ai_quality({
            **review_card,
            "permanent": False,
        }))

    def test_ai_quality_rejection_feedback_is_forwarded_for_one_model_replan(self):
        feedback = factory.ai_quality_replan_feedback({
            "code": "MEDIA_QUALITY_REJECTED",
            "data": {
                "quality_reviews": [{
                    "decision": "regenerate",
                    "rationale": "The actual pixels do not communicate the custom service.",
                    "issues": ["The focal point is unrelated to the offer."],
                    "specific_revision": "Use a concrete result-oriented scene tied to the supplied service facts.",
                }],
            },
        }, {"id": "hook-frame", "role": "hook"})

        self.assertEqual(len(feedback), 1)
        self.assertEqual(feedback[0]["brief_id"], "hook-frame")
        self.assertEqual(feedback[0]["decision"], "regenerate")
        self.assertIn("result-oriented", feedback[0]["specific_revision"])
        self.assertEqual(factory.ai_quality_replan_feedback({"code": "GENERATE_MEDIA_FAILED"}, {}), [])

    def test_generation_forwards_ai_reference_url_and_policy_verbatim(self):
        brief = {
            "id": "hero",
            "role": "product hero",
            "prompt": "Show the selected portrait example in a clean setting.",
            "image_model": "codex/gpt-5.6-terra",
            "aspect_ratio": "1:1",
            "reference_required": True,
            "reference_image_url": "https://img.example.test/ai-selected-reference.jpg",
            "reference_policy": "Planner fallback that must not be forwarded.",
        }
        strategy_frame = {
            "id": "hero",
            "source": "generated_image",
            "image_model": "codex/gpt-5.6-terra",
            "reference_required": True,
            "reference_policy": "Preserve the selected portrait style exactly.",
        }

        payload, problem = factory.build_generation_payload_from_ai_brief(
            brief, strategy_frame, "", self.listing["title"]
        )

        self.assertEqual(problem, "")
        self.assertEqual(
            payload["reference_image_url"], brief["reference_image_url"]
        )
        self.assertEqual(
            payload["reference_policy"], strategy_frame["reference_policy"]
        )
        self.assertEqual(payload["model"], "codex/gpt-5.6-terra")

    def test_blocks_reference_backed_generation_without_ai_reference_policy(self):
        brief = {
            "id": "hero",
            "role": "product hero",
            "prompt": "Show the selected portrait example in a clean setting.",
            "aspect_ratio": "4:5",
            "reference_required": True,
            "reference_image_url": "https://img.example.test/ai-selected-reference.jpg",
        }
        strategy_frame = {
            "id": "hero",
            "source": "generated_image",
            "reference_required": True,
        }

        payload, problem = factory.build_generation_payload_from_ai_brief(
            brief, strategy_frame, "", self.listing["title"]
        )

        self.assertIsNone(payload)
        self.assertIn("missing its reference policy", problem)

    def test_blocks_plan_without_ai_media_strategy(self):
        problem = factory.ai_media_strategy_problem(
            {"status": "ready_for_review", "variants": [{"media_items": []}]}
        )

        self.assertEqual(problem, "creative planner returned no AI media strategy")

    def test_reports_ai_understanding_failure_before_generic_strategy_error(self):
        problem = factory.ai_media_strategy_problem({
            "listing_understanding": {
                "available": False,
                "reason": "External AI returned invalid post-generation JSON.",
            }
        })

        self.assertEqual(
            problem,
            "creative planner AI understanding blocked: External AI returned invalid post-generation JSON.",
        )

    def test_accepts_complete_two_frame_ai_media_strategy(self):
        problem = factory.ai_media_strategy_problem(
            {
                "media_strategy": {
                    "format": "carousel",
                    "target_media_count": 2,
                    "required_visible_evidence": "Show the finished buyer-facing result clearly.",
                    "frame_count_rationale": "The lead proves the result and the second frame adds necessary usage context.",
                    "frames": [
                        {
                            "id": "example",
                            "source": "listing_image",
                            "reference_media_rank": 1,
                            "communication_goal": "Lead with the finished result.",
                            "visible_buyer_evidence": "The finished result is clearly visible.",
                            "evidence_strength": "primary",
                        },
                        {
                            "id": "context",
                            "source": "generated_image",
                            "prompt": "Show the ordering context.",
                            "aspect_ratio": "4:5",
                            "reference_required": False,
                            "communication_goal": "Show a useful buyer context.",
                            "visible_buyer_evidence": "The scene clarifies how the buyer uses the offer.",
                            "evidence_strength": "supporting",
                        },
                    ],
                }
            }
        )

        self.assertEqual(problem, "")

    def test_accepts_distinct_ai_platform_variants(self):
        problem = factory.ai_media_strategy_problem(
            {
                "media_strategy": {
                    "format": "carousel",
                    "target_media_count": 3,
                    "required_visible_evidence": "Show the finished buyer-facing result clearly.",
                    "frame_count_rationale": "Three distinct views each add buyer-relevant evidence.",
                    "frames": [
                        {"id": "hero", "source": "listing_image", "reference_media_rank": 1, "communication_goal": "Lead with the finished result.", "visible_buyer_evidence": "The finished result is clearly visible.", "evidence_strength": "primary"},
                        {"id": "detail", "source": "listing_image", "reference_media_rank": 2, "communication_goal": "Show a useful result detail.", "visible_buyer_evidence": "A concrete result detail is visible.", "evidence_strength": "supporting"},
                        {"id": "context", "source": "listing_image", "reference_media_rank": 3, "communication_goal": "Show another buyer-relevant view.", "visible_buyer_evidence": "An alternate finished view is visible.", "evidence_strength": "supporting"},
                    ],
                    "platform_variants": {
                        "instagram": {"format": "carousel", "frame_ids": ["hero", "detail", "context"], "buyer_evidence_frame_ids": ["hero", "detail"]},
                        "facebook": {"format": "multi_image", "frame_ids": ["context", "hero"], "buyer_evidence_frame_ids": ["context", "hero"]},
                        "pinterest": {"format": "single", "frame_ids": ["detail"], "buyer_evidence_frame_ids": ["detail"]},
                    },
                }
            },
            ["instagram", "facebook", "pinterest"],
        )

        self.assertEqual(problem, "")

    def test_blocks_master_frames_unused_by_every_requested_platform_variant(self):
        problem = factory.ai_media_strategy_problem(
            {
                "media_strategy": {
                    "format": "carousel",
                    "target_media_count": 2,
                    "required_visible_evidence": "Show the finished buyer-facing result clearly.",
                    "frame_count_rationale": "The planner proposed a selected Pin plus an unused alternate.",
                    "frames": [
                        {"id": "pin", "source": "listing_image", "reference_media_rank": 1, "communication_goal": "Lead with the result.", "visible_buyer_evidence": "The result is visible.", "evidence_strength": "primary"},
                        {"id": "unused", "source": "listing_image", "reference_media_rank": 2, "communication_goal": "Unused alternate.", "visible_buyer_evidence": "An alternate result is visible.", "evidence_strength": "supporting"},
                    ],
                    "platform_variants": {
                        "pinterest": {"format": "single", "frame_ids": ["pin"], "buyer_evidence_frame_ids": ["pin"]},
                    },
                }
            },
            ["pinterest"],
        )

        self.assertEqual(
            problem,
            "AI media strategy contains master frames unused by every requested platform variant: unused",
        )

    def test_blocks_multiplatform_strategy_without_ai_platform_variants(self):
        problem = factory.ai_media_strategy_problem(
            {
                "media_strategy": {
                    "format": "single",
                    "target_media_count": 1,
                    "required_visible_evidence": "Show the finished buyer-facing result clearly.",
                    "frame_count_rationale": "One complete hero is sufficient for this test.",
                    "frames": [
                        {"id": "hero", "source": "listing_image", "reference_media_rank": 1, "communication_goal": "Lead with the finished result.", "visible_buyer_evidence": "The finished result is clearly visible.", "evidence_strength": "primary"}
                    ],
                }
            },
            ["instagram", "facebook"],
        )

        self.assertEqual(problem, "AI media strategy returned no platform-specific variants")

    def test_accepts_ai_selected_review_card_strategy(self):
        problem = factory.ai_media_strategy_problem(
            {
                "media_strategy": {
                    "format": "single",
                    "target_media_count": 1,
                    "required_visible_evidence": "Show the exact customer proof selected by AI.",
                    "frame_count_rationale": "The single review card contains the complete proof.",
                    "frames": [
                        {
                            "id": "review-proof",
                            "source": "review_card",
                            "review_id": "review-42",
                            "context_note": "Custom digital family photo composition service",
                            "review_card_design": review_card_design(),
                            "aspect_ratio": "1:1",
                            "communication_goal": "Show exact customer proof.",
                            "visible_buyer_evidence": "The exact selected review is visible.",
                            "evidence_strength": "primary",
                        }
                    ],
                }
            }
        )

        self.assertEqual(problem, "")

    def test_review_card_payload_preserves_ai_selected_exact_evidence(self):
        brief = {
            "id": "review-proof",
            "role": "customer proof",
            "renderer": "review_card",
            "context_note": "Custom digital family photo composition service",
            "review_card_design": review_card_design(),
            "render_spec_sha256": "c" * 64,
            "aspect_ratio": "2:3",
            "review_evidence": {
                "review_id": "review-42",
                "listing_id": "listing-42",
                "exact_quote": "The result looked natural.",
                "rating": 5,
            },
        }
        strategy_frame = {
            "id": "review-proof",
            "source": "review_card",
            "review_id": "review-42",
            "context_note": "Custom digital family photo composition service",
            "review_card_design": review_card_design(),
            "aspect_ratio": "2:3",
        }

        payload, problem = factory.build_generation_payload_from_ai_brief(
            brief, strategy_frame, "", self.listing["title"]
        )

        self.assertEqual(problem, "")
        self.assertEqual(payload["renderer"], "review_card")
        self.assertEqual(
            payload["context_note"],
            "Custom digital family photo composition service",
        )
        self.assertEqual(payload["render_spec_sha256"], "c" * 64)
        self.assertEqual(payload["review_card_design"], review_card_design())
        self.assertEqual(payload["aspect_ratio"], "2:3")
        self.assertEqual(payload["review_evidence"], brief["review_evidence"])
        self.assertNotIn("reference_image_url", payload)

    def test_accepts_persistent_review_card_in_ai_selected_platform_media(self):
        variant = {
            "media_items": [
                {
                    "url": "https://manager.example.test/api/social?action=mediaAsset&id=review-card",
                    "source": "review_card",
                    "permanent": True,
                    "checksum_sha256": "b" * 64,
                }
            ]
        }

        media = factory.build_media_payloads_from_plan(
            variant, self.listing, "facebook"
        )

        self.assertEqual(len(media), 1)
        self.assertEqual(media[0]["source"], "review_card")

    def test_caption_quality_accepts_ai_review_of_exact_platform_caption(self):
        caption = "A specific buyer-facing caption written for this listing."
        problem = factory.caption_quality_problem({
            "platform": "facebook",
            "caption": caption,
            "caption_quality_review": {
                "approved": True,
                "decision": "approve",
                "reviewed_caption": caption,
                "rationale": "The copy is factual, specific, and appropriate for Facebook.",
            },
        })

        self.assertEqual(problem, "")

    def test_caption_quality_rejects_review_for_different_caption(self):
        problem = factory.caption_quality_problem({
            "platform": "instagram",
            "caption": "The final caption changed after review.",
            "caption_quality_review": {
                "approved": True,
                "decision": "approve",
                "reviewed_caption": "The earlier caption.",
                "rationale": "The earlier text was acceptable.",
            },
        })

        self.assertIn("does not match", problem)

    def test_web_research_executes_ai_planned_queries_and_reads_two_sources(self):
        original_bridge = factory.bridge
        original_web_search = factory.web_search
        original_fetch_excerpt = factory.fetch_research_excerpt
        seen_queries = []
        try:
            factory.bridge = lambda action, body=None, method="POST", timeout=40: {
                "success": True,
                "data": {
                    "status": "ready",
                    "rationale": "Verify the exact buyer moment selected from shop facts.",
                    "queries": [
                        {
                            "id": "q1",
                            "query": "AI selected current buyer moment evidence",
                            "purpose": "Check whether the selected angle is current and factual.",
                        }
                    ],
                },
            }

            def fake_search(query, limit=4):
                seen_queries.append(query)
                return [
                    {"title": "Source A", "url": "https://a.example.test/article", "description": "snippet A"},
                    {"title": "Source B", "url": "https://b.example.test/article", "description": "snippet B"},
                ]

            factory.web_search = fake_search
            factory.fetch_research_excerpt = lambda url, limit=1800: f"Readable page evidence from {url}"
            result = factory.build_current_research(
                {
                    "shop_totals": {"active_listings": 120},
                    "listings": [{
                        "listing_id": "listing-42",
                        "title": "Custom family photo composition",
                        "description": "A custom digital service that combines supplied family photos.",
                    }],
                },
                dt.datetime(2026, 7, 10, tzinfo=dt.timezone.utc),
            )
        finally:
            factory.bridge = original_bridge
            factory.web_search = original_web_search
            factory.fetch_research_excerpt = original_fetch_excerpt

        self.assertEqual(seen_queries, ["AI selected current buyer moment evidence"])
        self.assertTrue(result["external_research_used"])
        self.assertEqual(len(result["sources"]), 2)
        self.assertTrue(all(item["page_read"] for item in result["sources"]))
        self.assertNotIn("Etsy social media content trends", str(result))

    def test_persists_last_run_state_and_history_without_runtime_secrets(self):
        original_last = factory.LAST_RUN_PATH
        original_history = factory.RUN_HISTORY_PATH
        original_state = factory.RUN_STATE
        try:
            with tempfile.TemporaryDirectory() as directory:
                factory.LAST_RUN_PATH = Path(directory) / "last-run.json"
                factory.RUN_HISTORY_PATH = Path(directory) / "history.jsonl"
                factory.RUN_STATE = {
                    "run_id": "unit-run",
                    "status": "starting",
                    "stage": "startup",
                    "bridge_calls": [],
                }
                factory.persist_run_state("bridge:creativePlan", "running")
                factory.append_run_history()

                current = json.loads(factory.LAST_RUN_PATH.read_text(encoding="utf-8"))
                history = json.loads(factory.RUN_HISTORY_PATH.read_text(encoding="utf-8").strip())
                self.assertEqual(current["stage"], "bridge:creativePlan")
                self.assertEqual(history["run_id"], "unit-run")
                self.assertNotIn("token", json.dumps(current).lower())
        finally:
            factory.LAST_RUN_PATH = original_last
            factory.RUN_HISTORY_PATH = original_history
            factory.RUN_STATE = original_state

    def test_queue_record_capacity_keeps_one_campaign_whole_at_target_boundary(self):
        self.assertTrue(factory.queue_record_capacity_allows_package(0, 3, 3))
        self.assertTrue(factory.queue_record_capacity_allows_package(1, 2, 3))
        self.assertTrue(factory.queue_record_capacity_allows_package(1, 3, 3))
        self.assertFalse(factory.queue_record_capacity_allows_package(3, 1, 3))
        self.assertFalse(factory.queue_record_capacity_allows_package(0, 0, 3))

    def test_run_succeeds_when_queue_record_deficit_is_filled(self):
        self.assertEqual(factory.factory_run_exit_code(3, 3, 1, 8), 0)
        self.assertEqual(factory.factory_run_exit_code(2, 3, 1, 8), 1)

    def test_run_succeeds_when_campaign_package_cap_is_reached(self):
        self.assertEqual(factory.factory_run_exit_code(8, 24, 8, 8), 0)
        self.assertEqual(factory.factory_run_exit_code(8, 24, 7, 8), 1)

    def test_review_card_repair_allows_one_explicit_fingerprint_change(self):
        seen = {}
        initial = {
            "id": "review_frame",
            "renderer": "review_card",
            "render_spec_sha256": "a" * 64,
        }
        replacement = {
            **initial,
            "render_spec_sha256": "b" * 64,
        }
        replacement_plan = {
            "media_strategy": {
                "accepted_asset_decisions": [
                    {"brief_id": "review_frame", "decision": "discard"},
                ],
            },
        }

        self.assertEqual(factory.review_card_render_repair_problem(initial, {}, seen), "")
        factory.record_successful_review_card_render_specs(
            [(initial, {"renderer": "review_card", "render_spec_sha256": "a" * 64})],
            [{"brief_id": "review_frame"}],
            seen,
        )
        self.assertEqual(
            factory.review_card_render_repair_problem(replacement, replacement_plan, seen),
            "",
        )
        factory.record_successful_review_card_render_specs(
            [(replacement, {"renderer": "review_card", "render_spec_sha256": "b" * 64})],
            [{"brief_id": "review_frame"}],
            seen,
        )
        self.assertIn(
            "more than once",
            factory.review_card_render_repair_problem(
                {**replacement, "render_spec_sha256": "c" * 64},
                replacement_plan,
                seen,
            ),
        )

    def test_review_card_repair_rejects_identical_or_implicit_rebuild(self):
        seen = {}
        brief = {
            "id": "review_frame",
            "renderer": "review_card",
            "render_spec_sha256": "a" * 64,
        }
        self.assertEqual(factory.review_card_render_repair_problem(brief, {}, seen), "")
        factory.record_successful_review_card_render_specs(
            [(brief, {"renderer": "review_card", "render_spec_sha256": "a" * 64})],
            [{"brief_id": "review_frame"}],
            seen,
        )
        self.assertIn("identical", factory.review_card_render_repair_problem(brief, {}, seen))
        self.assertIn(
            "without explicitly discarding",
            factory.review_card_render_repair_problem(
                {**brief, "render_spec_sha256": "b" * 64},
                {},
                seen,
            ),
        )

    def test_failed_review_card_render_does_not_consume_fingerprint(self):
        seen = {}
        brief = {
            "id": "review_frame",
            "renderer": "review_card",
            "render_spec_sha256": "a" * 64,
        }
        factory.record_successful_review_card_render_specs(
            [(brief, {"renderer": "review_card", "render_spec_sha256": "a" * 64})],
            [],
            seen,
        )
        self.assertEqual(factory.review_card_render_repair_problem(brief, {}, seen), "")

    def test_post_generation_replan_budget_is_at_most_three(self):
        self.assertLessEqual(factory.MAX_POST_GENERATION_REPLANS, 3)

    def test_factory_deadline_bounds_individual_bridge_timeouts(self):
        self.assertEqual(factory.bounded_timeout_for_deadline(900, 125.0, 100.0), 25)
        self.assertEqual(factory.bounded_timeout_for_deadline(20, 125.0, 100.0), 20)
        self.assertEqual(factory.bounded_timeout_for_deadline(900, 99.0, 100.0), 0)
        self.assertLessEqual(factory.FACTORY_RUN_BUDGET_SECONDS, 2700)

    def test_media_generation_requires_budget_that_can_finish_provider_work(self):
        self.assertFalse(factory.media_generation_budget_allows_start(
            factory.MIN_GENERATE_MEDIA_BUDGET_SECONDS - 1
        ))
        self.assertTrue(factory.media_generation_budget_allows_start(
            factory.MIN_GENERATE_MEDIA_BUDGET_SECONDS
        ))

    def test_alternative_candidate_requires_a_complete_reserved_budget(self):
        self.assertTrue(factory.candidate_budget_allows_start(0, 1))
        self.assertTrue(factory.candidate_budget_allows_start(
            1, factory.MIN_CANDIDATE_BUDGET_SECONDS
        ))
        self.assertFalse(factory.candidate_budget_allows_start(
            1, factory.MIN_CANDIDATE_BUDGET_SECONDS - 1
        ))

    def test_final_factory_accounting_survives_process_status_update(self):
        original_last = factory.LAST_RUN_PATH
        original_state = factory.RUN_STATE
        try:
            with tempfile.TemporaryDirectory() as directory:
                factory.LAST_RUN_PATH = Path(directory) / "last-run.json"
                factory.RUN_STATE = {
                    "run_id": "unit-final-report",
                    "status": "running",
                    "stage": "factory",
                    "bridge_calls": [],
                }

                exit_code = factory.persist_factory_report(
                    queue_records_created=1,
                    queue_record_deficit=20,
                    campaign_packages_created=1,
                    campaign_package_limit=1,
                    created_count=1,
                    blocked_count=0,
                )
                factory.persist_run_state("factory", "completed", exit_code=exit_code)

                current = json.loads(factory.LAST_RUN_PATH.read_text(encoding="utf-8"))
                self.assertEqual(exit_code, 0)
                self.assertEqual(current["campaign_packages_created"], 1)
                self.assertEqual(current["queue_records_created"], 1)
                self.assertEqual(current["queue_record_deficit_remaining"], 19)
                self.assertEqual(current["created_count"], 1)
        finally:
            factory.LAST_RUN_PATH = original_last
            factory.RUN_STATE = original_state

    def test_projected_variant_count_is_checked_before_review_draft_save(self):
        source = Path(factory.__file__).read_text(encoding="utf-8")

        projection = source.index("projected_variant_count = len(campaign_payloads)")
        capacity_check = source.index("queue_record_capacity_allows_package(", projection)
        save = source.index('bridge("saveReviewDraft"', projection)
        self.assertLess(projection, capacity_check)
        self.assertLess(capacity_check, save)

    def test_queue_record_and_campaign_package_units_are_not_converted(self):
        source = Path(factory.__file__).read_text(encoding="utf-8")

        self.assertIn('"unit": "platform_queue_record"', source)
        self.assertIn("campaign_package_limit = max(0, CREATE_PER_RUN)", source)
        self.assertNotIn("min(CREATE_PER_RUN, queue_record_deficit)", source)
        self.assertIn('"whole_campaign_overflow_allowed": True', source)
        self.assertIn("allow_one_package_to_cross_the_record_target", source)
        self.assertNotIn("campaign package must fit the remaining record deficit", source)
        self.assertNotIn("do not propose a campaign package larger than the remaining record deficit", source)
        self.assertEqual(source.count('"queue_accounting": queue_accounting'), 1)


if __name__ == "__main__":
    unittest.main()
