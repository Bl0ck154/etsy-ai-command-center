// api/agent/tools-schema.js — AI Agent tool definitions
import { IMG_PROMPT_SYSTEM } from '../../public/utils/image-prompt-constants.js';

const OWNER_UI_COPY_SCHEMA = {
  type: 'object',
  description: 'Owner-facing UI copy for the action card. Match the conversation language and tone for the shop owner. This must not control Etsy-facing listing text, image prompts, tags, descriptions, or buyer-facing alt text.',
  properties: {
    heading: { type: 'string' },
    preview_status: { type: 'string' },
    approval_status: { type: 'string' },
    notice: { type: 'string' },
    target_listing_label: { type: 'string' },
    current_label: { type: 'string' },
    new_label: { type: 'string' },
    no_values_warning: { type: 'string' },
    no_field_changes: { type: 'string' },
    approve_button: { type: 'string' },
    cancel_button: { type: 'string' },
    review_line: { type: 'string' },
    visual_brief_label: { type: 'string' },
    slots_label: { type: 'string' },
    generated_label: { type: 'string' },
    generated_help_listing: { type: 'string' },
    generated_help_draft: { type: 'string' },
    current_images_label: { type: 'string' },
    selected_images_label: { type: 'string' },
    generate_button: { type: 'string' },
    continue_button: { type: 'string' },
    regenerate_button: { type: 'string' },
    apply_button: { type: 'string' },
    attach_draft_button: { type: 'string' },
    delete_button: { type: 'string' },
    replace_notice: { type: 'string' },
    delete_notice: { type: 'string' },
    cover_badge: { type: 'string' },
    preview_badge: { type: 'string' },
    view_button: { type: 'string' },
    download_button: { type: 'string' },
    provider_label: { type: 'string' },
    saved_image_label: { type: 'string' },
    generated_image_alt: { type: 'string' },
    new_draft_label: { type: 'string' },
    image_unavailable_label: { type: 'string' },
    new_listing_draft_title: { type: 'string' },
    draft_studio_label: { type: 'string' },
    mode_add: { type: 'string' },
    mode_replace_cover: { type: 'string' },
    mode_replace_all: { type: 'string' },
    mode_replace_selected: { type: 'string' },
    mode_delete_selected: { type: 'string' },
    disabled_label: { type: 'string' },
    restored_action_reason: { type: 'string' },
    generation_progress_label: { type: 'string' },
    completed_label: { type: 'string' },
    failed_label: { type: 'string' },
    generated_summary_label: { type: 'string' },
    generation_review_help: { type: 'string' },
    generation_failed_label: { type: 'string' },
    retry_button: { type: 'string' },
  },
};

export const IMAGE_PLAN_UI_COPY_REQUIRED = [
  'heading',
  'preview_status',
  'approval_status',
  'notice',
  'target_listing_label',
  'review_line',
  'visual_brief_label',
  'slots_label',
  'generated_label',
  'generated_help_listing',
  'generated_help_draft',
  'current_images_label',
  'selected_images_label',
  'generate_button',
  'continue_button',
  'regenerate_button',
  'apply_button',
  'attach_draft_button',
  'delete_button',
  'cancel_button',
  'replace_notice',
  'delete_notice',
  'cover_badge',
  'preview_badge',
  'view_button',
  'download_button',
  'provider_label',
  'saved_image_label',
  'generated_image_alt',
  'new_draft_label',
  'image_unavailable_label',
  'new_listing_draft_title',
  'draft_studio_label',
  'mode_add',
  'mode_replace_cover',
  'mode_replace_all',
  'mode_replace_selected',
  'mode_delete_selected',
  'disabled_label',
  'restored_action_reason',
  'generation_progress_label',
  'completed_label',
  'failed_label',
  'generated_summary_label',
  'generation_review_help',
  'generation_failed_label',
  'retry_button',
];

const OWNER_PROGRESS_MESSAGE_SCHEMA = {
  type: 'string',
  description: 'Required concise owner-facing activity label for this tool call. Write it in the shop owner\'s current conversation language and make it read naturally both while running and after a completion marker; prefer a specific noun-style label such as "Listing image analysis" over a first-person sentence. Describe the concrete action, not internal reasoning, generic AI activity, step numbers, or Etsy buyer-facing copy.',
};

// Kept outside provider tool definitions so runtime scope is testable without
// sending non-standard metadata to model APIs.
export const AGENT_TOOL_RUNTIME_CONTRACTS = Object.freeze({
  list_shop_listings: { execution: 'server_read', targets: ['shop'] },
  search_shop_listings: { execution: 'server_read', targets: ['shop'] },
  get_listing_details: { execution: 'server_read', targets: ['etsy_listing'] },
  get_shop_fulfillment_profiles: { execution: 'server_read', targets: ['shop'] },
  search_seller_taxonomy: { execution: 'server_read', targets: ['shop'] },
  analyze_listing_images: { execution: 'server_read', targets: ['etsy_listing'] },
  find_listing: { execution: 'server_read', targets: ['shop'] },
  get_listing_inventory: { execution: 'server_read', targets: ['etsy_listing'] },
  get_recent_orders: { execution: 'server_read', targets: ['shop'] },
  get_shop_stats: { execution: 'server_read', targets: ['shop'] },
  get_recent_reviews: { execution: 'server_read', targets: ['shop'] },
  audit_listing_compliance: { execution: 'server_read', targets: ['etsy_listing'] },
  validate_listing_before_publish: { execution: 'server_read', targets: ['etsy_listing', 'create_draft'] },
  find_listings_missing_personalization_migration: { execution: 'server_read', targets: ['shop'] },
  get_open_orders_with_personalization: { execution: 'server_read', targets: ['shop'] },
  get_shop_operating_context: { execution: 'server_read', targets: ['shop'] },
  save_shop_operating_context: { execution: 'server_write', targets: ['shop'] },
  open_current_create_draft: { execution: 'client_navigation', targets: ['create_draft'] },
  delete_shop_operating_context: { execution: 'server_write', targets: ['shop'] },
  navigate_to_page: { execution: 'client_navigation', targets: ['page'] },
  open_current_draft_image_generator: { execution: 'client_action', targets: ['create_draft'] },
  propose_social_post: { execution: 'owner_approval', targets: ['social'], response_field: 'pending_social_post' },
  propose_updates: { execution: 'owner_approval', targets: ['etsy_listing'], response_field: 'pending_updates' },
  propose_listing_image_set: { execution: 'owner_approval', targets: ['etsy_listing', 'create_draft'], response_field: 'pending_listing_images' },
  act_on_listing_image_plan: { execution: 'client_action', targets: ['etsy_listing', 'create_draft'] },
  propose_clear_variations: { execution: 'owner_approval', targets: ['etsy_listing'], response_field: 'pending_clear_variations' },
  propose_remove_variation_property: { execution: 'owner_approval', targets: ['etsy_listing'], response_field: 'pending_remove_variation_property' },
  propose_inventory_price_update: { execution: 'owner_approval', targets: ['etsy_listing'], response_field: 'pending_price_multiplier_inventory' },
  schedule_social_post: { execution: 'owner_approval', targets: ['social'], response_field: 'pending_scheduled_post' },
  get_scheduled_posts: { execution: 'client_read', targets: ['social'] },
  batch_schedule_posts: { execution: 'owner_approval', targets: ['social'], response_field: 'pending_batch_schedule' },
  delete_scheduled_post: { execution: 'owner_approval', targets: ['social'], response_field: 'pending_delete_post' },
  save_memory: { execution: 'server_write', targets: ['operator_memory'] },
  delete_memory: { execution: 'server_write', targets: ['operator_memory'] },
  fill_ui_fields: { execution: 'owner_approval', targets: ['current_page'], response_field: 'pending_field_fills' },
  propose_duplicate_listing: { execution: 'owner_approval', targets: ['etsy_listing'], response_field: 'pending_duplicate' },
  generate_listing_content: { execution: 'server_job', targets: ['etsy_listing', 'create_draft'], response_field: 'pending_generate_listing' },
  set_variations: { execution: 'owner_approval', targets: ['etsy_listing', 'create_draft'], response_field: 'pending_variations' },
  etsy_api_call: { execution: 'server_read', targets: ['shop', 'etsy_listing'] },
  execute_javascript: { execution: 'sandbox_compute', targets: ['context'] },
  list_message_conversations: { execution: 'server_read', targets: ['message_cache'] },
  get_message_conversation: { execution: 'server_read', targets: ['message_cache'] },
  get_message_playbook: { execution: 'server_read', targets: ['message_playbook'] },
  update_message_playbook: { execution: 'server_write', targets: ['message_playbook'] },
  get_message_automation_policy: { execution: 'server_read', targets: ['message_automation'] },
  update_message_automation_policy: { execution: 'server_write', targets: ['message_automation'] },
  prepare_message_draft: { execution: 'server_write', targets: ['message_outbox'] },
});


const TOOL_DEFINITIONS = [
  {
    name: 'list_shop_listings',
    description: 'Fetch Etsy listings by state (active, draft, inactive). Returns listing_id, title, description (first 600 chars), tags, price, views, favorites, should_auto_renew, etsy_url, and image_url when available. Use state="draft" to find drafts.',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['active', 'draft', 'inactive'], description: 'State of listings to fetch (default: active)' },
        limit: { type: 'number', description: 'Max listings to fetch (default 200)' },
        offset: { type: 'number', description: 'Offset for pagination (default 0). Use this to page through the entire shop.' },
      },
    },
  },
  {
    name: 'search_shop_listings',
    description: 'Search the shop\'s active listings using Etsy\'s native search API. Useful when looking for a specific item among hundreds of listings. You MUST translate user requests into English keywords before searching, as titles are usually in English.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Search keywords (in English)' },
        limit: { type: 'number', description: 'Max matches (default 10)' }
      },
      required: ['keywords']
    }
  },
  {
    name: 'get_listing_details',
    description: 'Get full details of ONE existing Etsy listing by ID, including complete description, listing type, current shipping_profile_id, readiness_state_id derived from the listing/inventory offerings, personalization questions, and inventory summary. Preserve returned fulfillment profile IDs mechanically unless the owner explicitly asks to change them.',
    input_schema: {
      type: 'object',
      required: ['listing_id'],
      properties: {
        listing_id: { type: 'number' },
      },
    },
  },
  {
    name: 'get_shop_fulfillment_profiles',
    description: 'Read the shop\'s existing Etsy shipping and processing/readiness profiles using the dedicated shop endpoints. Use for this workflow only when an existing physical listing truly has no current profile ID. Do not replace valid profile IDs already returned by get_listing_details.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'search_seller_taxonomy',
    description: 'Search Etsy seller taxonomy nodes and return numeric taxonomy_id candidates with full category paths. Use when a target truly has no taxonomy_id. The model must choose the semantically correct candidate from product facts; this retrieval tool does not make that business decision.',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Concise English product/category query grounded in the listing facts.' },
        limit: { type: 'number', description: 'Candidate limit, default 12.' },
      },
    },
  },
  {
    name: 'analyze_listing_images',
    description: 'Read-only AI vision analysis of the actual current Etsy listing image pixels. Use when the user asks to inspect, review, compare, or decide what to add/change based on existing listing images. Never writes to Etsy.',
    input_schema: {
      type: 'object',
      required: ['listing_id'],
      properties: {
        listing_id: { type: 'number', description: 'Target Etsy listing ID' },
        image_ranks: { type: 'array', items: { type: 'number' }, description: 'Optional 1-based image ranks to analyze, e.g. [1] for cover or [3] for the third image' },
        question: { type: 'string', description: 'Optional owner question or evaluation focus' },
      },
    },
  },
  {
    name: 'find_listing',
    description: 'Resolve an exact numeric Etsy listing ID immediately, or return ranked candidates for the model to choose semantically from title keywords. Use before any listing-specific read/write when the owner does not provide an exact ID. Never treat a lexical candidate as confirmed when product context remains ambiguous.',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'User description / title keywords for the target listing' },
        limit: { type: 'number', description: 'Max matches to return when ambiguous, default 3' },
      },
    },
  },
  {
    name: 'get_listing_inventory',
    description: 'Read current Etsy inventory/variations for one listing. Use before removing existing variations so prices and quantities are visible in the approval snapshot.',
    input_schema: {
      type: 'object',
      required: ['listing_id'],
      properties: {
        listing_id: { type: 'number' },
      },
    },
  },
  {
    name: 'get_recent_orders',
    description: 'Get recent current paid orders from the shop. Canceled and fully refunded receipts are excluded even when Etsy still reports is_paid=true.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of orders (default 25, max 100)' },
      },
    },
  },
  {
    name: 'get_shop_stats',
    description: 'Get paid, non-cancelled order count and revenue for a time period. This tool does not return listing views; use list_shop_listings for current per-listing view counts.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Stats for last N days (default 30)' },
      },
    },
  },
  {
    name: 'get_recent_reviews',
    description: 'Fetch the most recent shop reviews. Returns reviewer name, rating (1-5), review text, listing_id, and date. Use when user asks about recent feedback, last review, or wants to find a listing by review activity.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of reviews to fetch (default 10, max 25)' },
      },
    },
  },
  {
    name: 'audit_listing_compliance',
    description: 'Audit one listing for Etsy readiness, current Etsy listing guidance, risky claims, media, price, category, and personalization migration issues. Use before recommending edits or publishing. After success, follow the active owner-facing guidance disclosure supplied by the system prompt.',
    input_schema: {
      type: 'object',
      required: ['listing_id'],
      properties: {
        listing_id: { type: 'number', description: 'Etsy listing ID to audit' },
      },
    },
  },
  {
    name: 'validate_listing_before_publish',
    description: 'Validate draft/current listing fields before publish. Can use a listing_id, the visible Create page, or context.active_create_draft when the owner is chatting from another page. The active server draft is authoritative and must never be treated as empty merely because Create is not visible. Returns publish_ready, score, and exact blockers.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: { type: 'number', description: 'Optional listing ID. If omitted, uses current page context.' },
      },
    },
  },
  {
    name: 'find_listings_missing_personalization_migration',
    description: 'Scan active listings and find listings that appear personalized but lack new multiple personalization question data or still rely on legacy personalization fields.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Listings to scan (default 100, max 200)' },
      },
    },
  },
  {
    name: 'get_open_orders_with_personalization',
    description: 'Find actionable paid unshipped orders and show transaction personalization details when Etsy returns them. Canceled and fully refunded receipts are always excluded. Use for checking orders that may need buyer input.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Orders to check (default 25, max 100)' },
      },
    },
  },
  {
    name: 'get_shop_operating_context',
    description: 'Read durable shop operating context shared by every authenticated operator of this Etsy shop: brand rules, personalization defaults, pricing notes, fulfillment constraints, workflows, and verified operational learnings. The context is normally preloaded; call this only when it is absent or a fresh read is needed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_shop_operating_context',
    description: 'Persist a durable shop-wide fact or rule that must be shared with every authenticated operator of this Etsy shop. Use proactively for verified brand voice, product constraints, fulfillment rules, pricing policy, personalization defaults, and shared workflows. Do not use for one operator\'s reply style/UI preference, transient tasks, uncertain inferences, customer/order details, or secrets.',
    input_schema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', description: 'Short summary of the rule/preference/learning' },
        category: { type: 'string', enum: ['rule', 'preference', 'pricing', 'personalization', 'migration', 'workflow'], description: 'Context category' },
        details: { type: 'string', description: 'Optional concise details' },
      },
    },
  },
  {
    name: 'open_current_create_draft',
    description: 'Open and restore the authoritative server-backed Create draft exactly as saved. Use when the owner asks to open, retry, review, or publish the current draft, especially when chatting outside the Create page. This action must not generate, rewrite, reset, or prefill listing content. If context.active_create_draft is absent, explain that no saved draft exists instead of starting a new listing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_shop_operating_context',
    description: 'Delete one shared shop-memory item by id when the owner asks to forget or replace a shop-wide rule or fact. Use ids from context.shop_operating_context or get_shop_operating_context.',
    input_schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Shared shop-memory item id.' },
      },
    },
  },
  {
    name: 'navigate_to_page',
    description: 'Navigate the user to a general app page when they explicitly ask to go/open/show it. This tool must never prefill Create or be used to open/retry an existing listing draft; use open_current_create_draft for the saved draft and generate_listing_content for an explicitly requested new listing.',
    input_schema: {
      type: 'object',
      required: ['page'],
      properties: {
        page: {
          type: 'string',
          enum: ['dashboard', 'listings', 'create', 'bulk', 'gallery', 'orders', 'social', 'schedule', 'analytics', 'competitor', 'settings'],
          description: 'Page ID to navigate to',
        },
        params: {
          type: 'object',
          description: 'Optional navigation-only params. For "listings": { listing_id: number } may jump to a listing. Do not pass description, price, listing type, generated content, or other Create prefill data.',
        },
      },
    },
  },
  {
    name: 'open_current_draft_image_generator',
    description: 'Open the manual image studio for the currently active Create-page draft. Use only when the owner explicitly asks to open the studio/editor itself without asking the agent to plan images. Do not use for a request with creative direction, a requested count, named services/features, one-image-per-item instructions, an existing image-plan card, or image-plan feedback; use propose_listing_image_set for those so the model-authored plan is preserved.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short reason based on the user request.',
        },
      },
    },
  },
  {
    name: 'propose_social_post',
    description: 'Propose a social media post for user confirmation. Write a compelling caption with hashtags. Call when user asks to post/share a listing to social media (Instagram, Facebook, Pinterest, etc.).',
    input_schema: {
      type: 'object',
      required: ['caption'],
      properties: {
        caption:           { type: 'string', description: 'Post caption with hashtags, ready to publish' },
        platform:          { type: 'string', enum: ['all', 'instagram', 'facebook', 'pinterest', 'tiktok'], description: 'Target platform (default: all)' },
        listing_id:        { type: 'number', description: 'Related Etsy listing ID (optional)' },
        listing_title:     { type: 'string', description: 'Listing title for display in UI (optional)' },
        listing_image_url: { type: 'string', description: 'Listing image URL from get_listing_details (image_url field) — shown as thumbnail in the post preview' },
      },
    },
  },
  {
    name: 'propose_updates',
    description: 'Propose a batch of listing updates for owner approval. Supported existing Etsy listing content is title, description, tags, base price, auto-renew, or personalization questions. The user sees exact before/after values and can approve or cancel. This tool does not add, remove, or rewrite variation inventory and does not generate or attach images; use the dedicated variation and image tools for those operations.',
    input_schema: {
      type: 'object',
      required: ['summary', 'updates'],
      properties: {
        summary: { type: 'string', description: 'Short human-readable summary, e.g. "Replace 2024→2026 in 7 listings"' },
        ui_copy: OWNER_UI_COPY_SCHEMA,
        updates: {
          type: 'array',
          items: {
            type: 'object',
            required: ['listing_id', 'listing_title'],
            properties: {
              listing_id:        { type: 'number' },
              listing_title:     { type: 'string', description: 'Current listing title (for display in UI)' },
              title:             { type: 'string', description: 'New title (omit if not changing)' },
              description:       { type: 'string', description: 'New description (omit if not changing)' },
              tags:              { type: 'array', items: { type: 'string' }, description: 'New tags array (omit if not changing)' },
              price:             { type: 'number', description: 'New price in USD (omit if not changing)' },
              should_auto_renew: { type: 'boolean', description: 'Enable or disable auto-renewal (omit if not changing)' },
              personalization_questions: {
                type: 'array',
                description: 'New multiple personalization questions. Use this for Etsy personalization changes instead of legacy personalization fields.',
                items: {
                  type: 'object',
                  required: ['question_type', 'question_text'],
                  properties: {
                    question_type: { type: 'string', enum: ['text_input', 'dropdown', 'file_upload'] },
                    question_text: { type: 'string' },
                    instructions: { type: 'string' },
                    required: { type: 'boolean' },
                    max_allowed_characters: { type: 'number' },
                    max_allowed_files: { type: 'number' },
                    options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'propose_listing_image_set',
    description: 'Propose generating a new image set for an Etsy listing or a not-yet-created listing draft. Use listing_id="draft" directly for an image-only brief; supplied title, description, service bullets, or the phrase "new listing" are image context and do not require generate_listing_content. For draft targets, set workflow_action="start" for a genuinely new product workflow; set workflow_action="continue" and copy context.agent_listing_workflow.workflow_id when revising or continuing the active product. Never reuse a stale workflow for a different product. The owner approves generation first, previews images in chat, then applies them. The model must author every slot explicitly; tools will not invent fallback cover/lifestyle slots. If the owner asks for one image per supplied service, feature, item, package, or other unit, count must equal the number of units and slots must preserve a one-to-one ordered mapping. Do not add a separate cover or turn the first requested unit into Cover/Hero/Main unless explicitly requested. For follow-up requests after an active pending/generated image plan, continue with only new complementary slots. If the owner says a cover already exists, asks for secondary/supporting/additional images, or asks not to make a cover, do not include a cover/hero/main slot. If you are also generating listing text because the owner explicitly requested it, wait for generate_listing_content to return before proposing images. For products whose identity depends on one exact printed artwork (such as a specific shirt, mug, sticker, or print), never generate more than one image without a reference_image; this restriction does not apply to a custom design-service listing that intentionally demonstrates distinct capabilities.',
    input_schema: {
      type: 'object',
      required: ['listing_id', 'listing_title', 'prompt', 'mode', 'count', 'slots', 'ui_copy'],
      properties: {
        listing_id: { type: 'string', description: 'Target Etsy listing ID or "draft" for new listing drafts' },
        listing_title: { type: 'string', description: 'Listing title for display' },
        workflow_action: { type: 'string', enum: ['start', 'continue'], description: 'For listing_id="draft": use start for a new product workflow; use continue only for the active product workflow already present in context.' },
        workflow_id: { type: 'string', description: 'For workflow_action="continue", copy the exact context.agent_listing_workflow.workflow_id. Omit for start.' },
        prompt: { type: 'string', description: 'Broad commercial image generation prompt. DO NOT specify exact colors or hex codes unless requested. DO NOT explicitly ban text (e.g. "no text") as it causes bad compositions.' },
        mode: { type: 'string', enum: ['add', 'replace_cover', 'replace_all', 'replace_selected', 'delete_selected'], description: 'How generated or selected images should be applied after approval' },
        count: { type: 'integer', minimum: 0, maximum: 10, description: 'Number of images to generate, 1-10; use 0 only for delete_selected. A relational request such as "one image for each of these six services" means count=6. For continuation/follow-up plans, this is the number of additional new images now, not the total including previous generated previews.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '4:5', '3:4', '4:3', '16:9'], description: 'Use 1:1 unless the owner explicitly requests another supported ratio. Do not infer 4:3 or another non-square ratio from the subject, service list, or text layout.' },
        reference_image: {
          type: 'object',
          description: 'Reference image for generation, usually the current/selected listing image URL. Include when available so generation preserves the actual product/design.',
          properties: {
            url: { type: 'string' },
            image_url: { type: 'string' },
            base64: { type: 'string' },
            mimeType: { type: 'string' },
          },
        },
        current_images: {
          type: 'array',
          description: 'Current listing images if known, for preview and safe deletion after upload',
          items: {
            type: 'object',
            properties: {
              listing_image_id: { type: 'number' },
              url: { type: 'string' },
              rank: { type: 'number' },
            },
          },
        },
        selected_images: {
          type: 'array',
          description: 'Specific current images selected for delete_selected or replace_selected. Include listing_image_id, url, and rank when available.',
          items: {
            type: 'object',
            properties: {
              listing_image_id: { type: 'number' },
              url: { type: 'string' },
              rank: { type: 'number' },
            },
          },
        },
        selected_image_ids: { type: 'array', items: { type: 'number' }, description: 'Current Etsy listing_image_id values to delete or replace' },
        selected_image_ranks: { type: 'array', items: { type: 'number' }, description: '1-based image ranks to delete or replace when IDs are not known' },
        slots: {
          type: 'array',
          minItems: 0,
          maxItems: 10,
          description: 'Required. Include exactly count model-authored items. For one-image-per-service/feature/item/package requests, preserve the supplied order and map each slot to exactly one requested unit; do not insert a generic cover or replace the first unit with one. Include only new slots for continuation plans and avoid repeating prior purposes, compositions, or rejected claims. If the owner says the cover already exists or asks for secondary/supporting images, none may be cover/hero/main. cover_hook is optional and must be 2-5 words if present.',
          items: {
            type: 'object',
            required: ['purpose', 'visual_prompt', 'alt_text'],
            properties: {
              purpose: { type: 'string', description: 'Specific selling role or the exact requested service/feature/item represented by this slot. Never label a slot Cover/Hero/Main unless the owner requested that role.' },
              visual_prompt: { type: 'string', description: 'Image generation prompt. Keep it broad and commercial. DO NOT specify exact hex colors or explicitly ban text.' },
              cover_hook: { type: 'string' },
              alt_text: { type: 'string' },
            },
          },
        },
        summary: { type: 'string', description: 'Short human-readable summary' },
        ui_copy: {
          ...OWNER_UI_COPY_SCHEMA,
          required: IMAGE_PLAN_UI_COPY_REQUIRED,
          description: 'Required owner-facing UI copy for this image-plan card, including generation progress labels. Fill every required field in the shop owner conversation language. Keep Etsy-facing prompt, visual_prompt, and alt_text in the buyer/listing language.',
        },
      },
    },
  },
  {
    name: 'act_on_listing_image_plan',
    description: 'Run an explicit user-approved action on the currently active listing image plan card. Use this ONLY when context.pending_listing_images already exists and the user clearly asks to execute the existing card action, such as generating the previews or applying/attaching already generated previews to the listing/draft. Do not use this to revise a plan, change image count, add more images, regenerate, or respond to creative feedback; for those, call propose_listing_image_set instead. For apply_to_listing, generated image IDs must already be present in context.pending_listing_images.generated_images unless the mode is delete_selected. If the tool returns a structured fault with required_transition, perform that transition with the named tool instead of asking the owner to repair browser storage or local data.',
    input_schema: {
      type: 'object',
      required: ['action', 'listing_id'],
      properties: {
        action: {
          type: 'string',
          enum: ['generate_previews', 'apply_to_listing'],
          description: 'Which visible image-plan card action the frontend should run.',
        },
        listing_id: {
          type: 'string',
          description: 'Required exact listing_id from context.pending_listing_images, or "draft". Never infer or omit this target.',
        },
        reason: {
          type: 'string',
          description: 'Short reason for the action, based on the user request.',
        },
      },
    },
  },
  {
    name: 'propose_clear_variations',
    description: 'Propose safely removing all variation properties from existing Etsy listings. Must be called after get_listing_inventory for each listing. User approves before API write.',
    input_schema: {
      type: 'object',
      required: ['listings'],
      properties: {
        summary: { type: 'string', description: 'Short human-readable summary' },
        listings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['listing_id', 'listing_title'],
            properties: {
              listing_id: { type: 'number' },
              listing_title: { type: 'string' },
              price: { type: 'number', description: 'Explicit final single price after removing all variations. Required when current variation prices differ.' },
              quantity: { type: 'number', description: 'Fallback single quantity if inventory quantity cannot be read' },
            },
          },
        },
      },
    },
  },
  {
    name: 'propose_remove_variation_property',
    description: 'Propose safely removing one named variation property from existing Etsy listings while preserving remaining variation properties, prices, and quantities from the inventory snapshot. Must be called after get_listing_inventory for each listing.',
    input_schema: {
      type: 'object',
      required: ['property_name', 'listings'],
      properties: {
        summary: { type: 'string', description: 'Short human-readable summary' },
        property_name: { type: 'string', description: 'Exact variation property to remove, e.g. Size' },
        listings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['listing_id', 'listing_title'],
            properties: {
              listing_id: { type: 'number' },
              listing_title: { type: 'string' },
              price: { type: 'number' },
              quantity: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'propose_inventory_price_update',
    description: 'Propose changing Etsy inventory offering prices while preserving all variations/properties and price_on_property. Use this instead of simple listing price updates whenever a listing has variations or the user asks to preserve variations.',
    input_schema: {
      type: 'object',
      required: ['mode', 'value', 'listings'],
      properties: {
        summary: { type: 'string', description: 'Short human-readable summary' },
        mode: { type: 'string', enum: ['multiply', 'set'], description: 'multiply = multiply every current offering price by value; set = set every offering price to value' },
        value: { type: 'number', description: 'Multiplier or target USD price depending on mode' },
        listings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['listing_id', 'listing_title'],
            properties: {
              listing_id: { type: 'number' },
              listing_title: { type: 'string' },
              price: { type: 'number', description: 'Fallback base price if inventory price cannot be read' },
              quantity: { type: 'number', description: 'Fallback quantity if inventory quantity cannot be read' },
            },
          },
        },
      },
    },
  },
  {
    name: 'schedule_social_post',
    description: 'Save a social media post as a draft or schedule it for a specific date/time. Use when user asks to schedule, save for later, or plan a post ahead of time.',
    input_schema: {
      type: 'object',
      required: ['caption'],
      properties: {
        caption:      { type: 'string', description: 'Post caption with hashtags, in the same language as the conversation' },
        platform:     { type: 'string', enum: ['all', 'instagram', 'facebook', 'pinterest', 'tiktok'], description: 'Target platform (default: all)' },
        listing_id:   { type: 'number', description: 'Related Etsy listing ID (optional)' },
        listing_title:     { type: 'string', description: 'Listing title for display (optional)' },
        listing_image_url: { type: 'string', description: 'Listing image URL from get_listing_details (image_url field) — shown as thumbnail in schedule page' },
        scheduled_at:      { type: 'string', description: 'ISO 8601 datetime string for when to post, e.g. "2026-04-10T14:00:00Z" (omit for draft)' },
      },
    },
  },
  {
    name: 'get_scheduled_posts',
    description: 'Get all scheduled and draft social media posts from the content calendar. Call this before creating a batch schedule to see what already exists.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'batch_schedule_posts',
    description: 'Create multiple scheduled social posts at once — content calendar. Shows user a preview table with all posts and dates. User clicks "Save all" to confirm.',
    input_schema: {
      type: 'object',
      required: ['posts'],
      properties: {
        posts: {
          type: 'array',
          description: 'Array of posts to schedule',
          items: {
            type: 'object',
            required: ['caption'],
            properties: {
              caption:           { type: 'string', description: 'Post caption with hashtags' },
              platform:          { type: 'string', enum: ['all', 'instagram', 'facebook', 'pinterest', 'tiktok'], description: 'Target platform' },
              scheduled_at:      { type: 'string', description: 'ISO 8601 datetime, e.g. "2026-04-20T10:00:00Z". Omit for draft.' },
              listing_id:        { type: 'number' },
              listing_title:     { type: 'string' },
              listing_image_url: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'delete_scheduled_post',
    description: 'Delete a scheduled or draft post by its ID. Shows a confirmation card — user clicks "Delete" to confirm. Use IDs from get_scheduled_posts.',
    input_schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id:              { type: 'string', description: 'Post ID from get_scheduled_posts' },
        caption_preview: { type: 'string', description: 'First ~60 chars of caption for display in confirmation card' },
      },
    },
  },
  {
    name: 'save_memory',
    description: 'Persist a stable private preference for the current authenticated operator, such as reply style, UI preference, or personal working method. Use proactively when it will materially improve that person\'s future conversations, even if they do not literally say "remember". Shop-wide business facts and rules must use save_shop_operating_context instead. Do not save transient requests, uncertain inferences, customer/order details, credentials, secrets, or information already present in context.agent_memory.',
    input_schema: {
      type: 'object',
      required: ['text', 'category'],
      properties: {
        text:     { type: 'string', description: 'A concise, self-contained memory that remains understandable outside the current chat (1-3 sentences max).' },
        category: { type: 'string', enum: ['preference', 'rule', 'fact', 'context'], description: 'Classify why this information is useful in future conversations.' },
      },
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a previously saved memory by its id. Use when user says "forget X" or wants to remove a remembered fact.',
    input_schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Memory id from context.agent_memory' },
      },
    },
  },
  {
    name: 'fill_ui_fields',
    description: 'Fill one or more visible input fields in the current page UI. Shows the user a preview card — they click "Apply" to actually fill the fields. Only use field_ids from context.available_fields.',
    input_schema: {
      type: 'object',
      required: ['fields'],
      properties: {
        summary: { type: 'string', description: 'Short description, e.g. "Fill listing title and tags"' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field_id', 'value'],
            properties: {
              field_id: { type: 'string', description: 'HTML element id from context.available_fields' },
              label:    { type: 'string', description: 'Human-readable field name for display' },
              value:    { type: 'string', description: 'Value to fill in' },
            },
          },
        },
      },
    },
  },
  {
    name: 'propose_duplicate_listing',
    description: 'Propose duplicating a listing with optional field changes. Call get_listing_details FIRST to get the original data, then call this with the changes. User will see a preview and can approve.',
    input_schema: {
      type: 'object',
      required: ['source_listing_id', 'source_title'],
          properties: {
            source_listing_id: { type: 'number', description: 'Original listing ID to duplicate' },
            source_title:      { type: 'string', description: 'Original listing title (for display)' },
            source_image_url:  { type: 'string', description: 'Original listing thumbnail URL from get_listing_details.image_url, if available' },
            source_state:      { type: 'string', description: 'Original listing state from get_listing_details.state, e.g. active, draft, inactive' },
            title:             { type: 'string', description: 'New title (if changing from original)' },
        description:       { type: 'string', description: 'New description (if changing from original)' },
        tags:              { type: 'array', items: { type: 'string' }, description: 'New tags (if changing from original)' },
        price:             { type: 'number', description: 'New price in USD (if changing from original)' },
        personalization_questions: {
          type: 'array',
          description: 'New personalization questions for the duplicated listing only. Do not call propose_updates on the source listing.',
          items: {
            type: 'object',
            required: ['question_type', 'question_text'],
            properties: {
              question_type: { type: 'string', enum: ['text_input', 'dropdown', 'file_upload'] },
              question_text: { type: 'string' },
              instructions: { type: 'string' },
              required: { type: 'boolean' },
              max_allowed_characters: { type: 'number' },
              max_allowed_files: { type: 'number' },
              options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
            },
          },
        },
        changes_summary:   { type: 'string', description: 'Human-readable summary of what changed, e.g. "Changed tags and price"' },
      },
    },
  },
  {
    name: 'generate_listing_content',
    description: 'Run the full Etsy content pipeline in English (US), regardless of the owner conversation or product-brief language, only when the owner explicitly asks to create, write, rewrite, or optimize listing content. Use target_type=create_draft for a new/not-yet-created listing or the active server Create draft. The resulting draft stays active in the conversation; continue this draft rather than regenerate its content when the owner asks for follow-up work. Use target_type=etsy_listing with the exact listing_id when rewriting or optimizing an existing Etsy listing; that path returns an owner approval plan for the same listing and never creates a replacement draft. Apply current Etsy guidance: do not keyword-stuff the title or promise ranking results. Do not call this merely because an image request mentions a "new listing" or supplies a title, description, or service bullets as image context. Do not also call fill_ui_fields or navigate_to_page.',
    input_schema: {
      type: 'object',
      required: ['target_type', 'description'],
      properties: {
        target_type: { type: 'string', enum: ['create_draft', 'etsy_listing'], description: 'Required target identity. Use etsy_listing for an existing numeric Etsy listing; use create_draft only for new or active Create drafts.' },
        listing_id: { type: 'number', description: 'Required when target_type=etsy_listing. Exact existing Etsy listing ID.' },
        listing_title: { type: 'string', description: 'Current title for the existing listing approval card.' },
        description:   { type: 'string', description: 'Product brief in any language: what the product is, key features, style, and target buyer. The downstream listing generator translates these facts and returns English (US) Etsy content.' },
        listing_type:  { type: 'string', enum: ['download', 'physical'], description: 'Listing type (default: download)' },
        price:         { type: 'string', description: 'Target price in USD' },
        extra:         { type: 'string', description: 'Extra instructions or requirements' },
        workflow_action: { type: 'string', enum: ['start', 'continue'], description: 'Use continue for the active draft image/listing workflow; use start for a genuinely new product listing.' },
        workflow_id: { type: 'string', description: 'For workflow_action="continue", copy the exact context.agent_listing_workflow.workflow_id. Omit for start.' },
        after_generation: { type: 'string', enum: ['none', 'attach_active_image_plan'], description: 'Use attach_active_image_plan only when the owner explicitly asked to attach/apply the already generated previews and listing content is the missing required transition. The client will resume that approved action after the draft is ready.' },
        attached_image_role: {
          type: 'string',
          enum: ['reference', 'listing_image'],
          description: 'When context.attached_image is present, choose how the uploaded original should be used. Use "listing_image" only when the owner explicitly wants the uploaded original attached unchanged to the draft/listing. Use "reference" when it should guide generated mockups or provide product/design context.',
        },
      },
    },
  },
  {
    name: 'set_variations',
    description: 'Propose a publish-ready variation change for either the active server-backed Create draft or an existing Etsy listing. Set target_type explicitly. For etsy_listing, pass the resolved numeric listing_id and current listing_title; the tool reads and mechanically preserves current shipping/readiness profile IDs. Fetch shop fulfillment profiles only if the existing listing truly lacks an ID. Each property has one unambiguous pricing_mode: final_price means its option amounts are final totals; surcharge means its option amounts are added to the final-price property. Optional personalization_questions belong to the same approval plan only when the owner explicitly requests them. Omit that field entirely to keep personalization unchanged. Do not claim anything changed before owner approval.',
    input_schema: {
      type: 'object',
      required: ['target_type'],
      properties: {
        target_type: { type: 'string', enum: ['create_draft', 'etsy_listing'], description: 'Use create_draft only for context.active_create_draft. Use etsy_listing when the owner names or resolves a numeric Etsy listing ID.' },
        listing_id: { type: 'number', description: 'Required when target_type=etsy_listing. Exact existing Etsy listing ID.' },
        listing_title: { type: 'string', description: 'Current existing Etsy listing title for the approval card. Required when target_type=etsy_listing.' },
        listing_type: { type: 'string', enum: ['download', 'physical'], description: 'Switch listing type. Must be "physical" to use variations.' },
        base_price: { type: 'number', minimum: 0.2, description: 'Publishable base/starting price. Use the current draft price unless the owner requested a new one.' },
        taxonomy_id: { type: 'integer', minimum: 1, description: 'Resolved Etsy seller taxonomy ID. For an existing listing, preserve its current ID; if absent, choose a candidate returned by search_seller_taxonomy.' },
        taxonomy_category: { type: 'string', description: 'Most specific accurate Etsy seller taxonomy category path/name. Required only when switching a target with no taxonomy_id to physical.' },
        shipping_profile_id: { type: 'integer', minimum: 1, description: 'For create_draft, select from context.active_create_draft.shipping_profiles. For etsy_listing, omit when the listing already has an ID; provide a selected shop profile only when the current listing truly has none.' },
        readiness_state_id: { type: 'integer', minimum: 1, description: 'For create_draft, select from context.active_create_draft.readiness_profiles. For etsy_listing, omit when the listing/inventory already has an ID; provide a selected shop profile only when the current listing truly has none.' },
        properties: {
          type: 'array',
          description: 'Variation properties (max 2). Each has a name and list of options.',
          items: {
            type: 'object',
            required: ['name', 'pricing_mode', 'options'],
            properties: {
              name:    { type: 'string', description: 'Property name: Color, Size, Material, Style, Finish, Length, Width, Scent, or any custom label' },
              pricing_mode: { type: 'string', enum: ['final_price', 'surcharge'], description: 'Use final_price for the primary price-driving property. Use surcharge for a secondary property whose amounts are added to the primary final price. Exactly one property should use final_price.' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'amount'],
                  properties: {
                    name: { type: 'string' },
                    amount: { type: 'number', minimum: 0, description: 'For final_price, the final total Etsy price (at least 0.20). For surcharge, the additive amount; use 0 for no surcharge.' },
                  },
                },
                description: 'Options with amounts interpreted only through this property pricing_mode.',
              },
            },
          },
        },
        personalization_questions: {
          type: 'array',
          minItems: 1,
          description: 'Optional buyer-facing Etsy personalization questions to replace in the same approval plan, only when the owner explicitly requests them. Omit this field to keep current personalization unchanged; never send an empty array. Do not ask for a choice already represented by a variation property.',
          items: {
            type: 'object',
            required: ['question_type', 'question_text'],
            properties: {
              question_type: { type: 'string', enum: ['text_input', 'dropdown', 'file_upload'] },
              question_text: { type: 'string' },
              instructions: { type: 'string' },
              required: { type: 'boolean' },
              max_allowed_characters: { type: 'number' },
              max_allowed_files: { type: 'number' },
              options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
            },
          },
        },
      },
    },
  },
  {
    name: 'list_message_conversations',
    description: 'Read Etsy conversations already stored in the local Messages Bridge cache. This never refreshes Etsy, opens a browser thread, approves a draft, or sends a message.',
    input_schema: {
      type: 'object',
      properties: {
        needs_attention: {
          type: 'boolean',
          description: 'Optional local dashboard filter: true means a new conversation has not yet been viewed here.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'integer', minimum: 0 },
        updated_after: { type: 'string', description: 'Optional ISO timestamp.' },
      },
    },
  },
  {
    name: 'get_message_conversation',
    description: 'Read one Etsy conversation and its currently cached messages. This is cache-only: it does not navigate Etsy or load older history. Never claim the history is complete unless the returned data proves it.',
    input_schema: {
      type: 'object',
      required: ['conversation_id'],
      properties: {
        conversation_id: { type: 'string', pattern: '^\\d+$' },
      },
    },
  },
  {
    name: 'get_message_playbook',
    description: 'Read the current shop message playbook: tone, hard rules, scenario instructions, forbidden phrases, and approved examples.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_message_playbook',
    description: 'Update selected fields in the shop message playbook. Read it first and pass its revision. This changes drafting guidance only; it cannot approve or send any Etsy message.',
    input_schema: {
      type: 'object',
      required: ['expected_revision', 'patch'],
      properties: {
        expected_revision: { type: 'integer', minimum: 0 },
        patch: {
          type: 'object',
          description: 'Partial playbook object. Supported top-level fields: tone, hard_rules, avoid_phrases, scenarios, examples. Omitted fields stay unchanged.',
          properties: {
            tone: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                response_length: { type: 'string' },
                language_policy: { type: 'string' },
                signature: { type: 'string' },
              },
            },
            hard_rules: { type: 'array', items: { type: 'string' } },
            avoid_phrases: { type: 'array', items: { type: 'string' } },
            scenarios: {
              type: 'object',
              description: 'Scenario-keyed partial objects with label, enabled, and instructions fields.',
              properties: Object.fromEntries([
                'how_to_send_files',
                'materials_sent_by_email',
                'how_to_order',
                'missing_materials',
                'deadline_variants_sent',
                'deadline_no_materials',
                'review_request',
                'freeform',
              ].map(key => [key, {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  enabled: { type: 'boolean' },
                  instructions: { type: 'string' },
                },
              }])),
            },
            examples: {
              type: 'array',
              items: {
                type: 'object',
                required: ['scenario', 'customer_message', 'ideal_reply'],
                properties: {
                  id: { type: 'string' },
                  scenario: { type: 'string' },
                  customer_message: { type: 'string' },
                  ideal_reply: { type: 'string' },
                  context: { type: 'string' },
                  notes: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'get_message_automation_policy',
    description: 'Read draft-trigger rules and their delays/cooldowns. All rules are permanently draft-only and require individual human approval.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_message_automation_policy',
    description: 'Update draft-trigger rules, delays, cooldowns, conditions, and enabled state. Read the policy first and pass its revision. This cannot change draft-only delivery or the human-approval requirement.',
    input_schema: {
      type: 'object',
      required: ['expected_revision', 'patch'],
      properties: {
        expected_revision: { type: 'integer', minimum: 0 },
        patch: {
          type: 'object',
          description: 'Partial policy. Rules use: id, label, enabled, event (new_message, order_paid, materials_missing, listing_deadline, order_completed), scenario, delay_minutes, cooldown_minutes, require_order_context, conditions, owner_notes.',
          properties: {
            enabled: { type: 'boolean' },
            rules: {
              type: 'array',
              items: {
                type: 'object',
                required: ['event', 'scenario'],
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  enabled: { type: 'boolean' },
                  event: { type: 'string', enum: ['new_message', 'order_paid', 'materials_missing', 'listing_deadline', 'order_completed'] },
                  scenario: { type: 'string', enum: ['how_to_send_files', 'materials_sent_by_email', 'how_to_order', 'missing_materials', 'deadline_variants_sent', 'deadline_no_materials', 'review_request', 'freeform'] },
                  delay_minutes: { type: 'integer', minimum: 0, maximum: 43200 },
                  cooldown_minutes: { type: 'integer', minimum: 0, maximum: 10080 },
                  require_order_context: { type: 'boolean' },
                  conditions: { type: 'string' },
                  owner_notes: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'prepare_message_draft',
    description: 'Create one Etsy reply candidate in AWAITING_APPROVAL after reading the cached conversation and playbook. This tool cannot approve or send. Never claim delivery; tell the owner the draft is waiting for review.',
    input_schema: {
      type: 'object',
      required: ['conversation_id', 'body', 'scenario', 'reason'],
      properties: {
        conversation_id: { type: 'string', pattern: '^\\d+$' },
        body: { type: 'string', minLength: 1, maxLength: 10000 },
        scenario: { type: 'string', enum: ['how_to_send_files', 'materials_sent_by_email', 'how_to_order', 'missing_materials', 'deadline_variants_sent', 'deadline_no_materials', 'review_request', 'freeform'] },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
        source_message_id: { type: 'string', maxLength: 160, description: 'Exact incoming Etsy message being answered. Omit only when the latest incoming message is unambiguous.' },
        trigger_rule_id: { type: 'string', maxLength: 80 },
      },
    },
  },
  {
    name: 'etsy_api_call',
    description: 'Read data from any Etsy API V3 endpoint when no specific read tool exists. This tool is strictly read-only. All Etsy writes must use a dedicated proposal tool so the owner receives a clear approval card before anything changes.',
    input_schema: {
      type: 'object',
      required: ['endpoint', 'method'],
      properties: {
        endpoint: { type: 'string', description: 'Path relative to Etsy /v3/application, e.g. /shops/{shop_id}/listings or /listings/active. Never prefix it with /application and do not include the host.' },
        method: { type: 'string', enum: ['GET'] },
        query: { type: 'object', description: 'Query parameters as key-value pairs' }
      }
    }
  },
  {
    name: 'execute_javascript',
    description: 'Execute JavaScript code in a secure sandboxed environment for data processing, filtering, math, or string manipulation. Assign the final output to `result`. The read-only `context` object contains listings, page_context, and agent_memory. NEVER attempt to access process, require, import, fs, or environment variables — the sandbox blocks all of these.',
    input_schema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Must set a `result` variable with the output. Read-only `context` is available. Max 3s execution, 8MB memory.' }
      }
    }
  }
];

export const TOOLS = TOOL_DEFINITIONS.map(tool => ({
  ...tool,
  input_schema: {
    ...tool.input_schema,
    properties: {
      progress_message: OWNER_PROGRESS_MESSAGE_SCHEMA,
      ...(tool.input_schema?.properties || {}),
    },
    required: [...new Set([...(tool.input_schema?.required || []), 'progress_message'])],
  },
}));

export function schemaToGemini(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type') out[k] = String(v).toUpperCase();
    else if (k === 'properties' && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, schemaToGemini(pv)]));
    } else if (k === 'items' && typeof v === 'object') out[k] = schemaToGemini(v);
    else out[k] = v;
  }
  return out;
}

export const GEMINI_TOOLS = [{ function_declarations: TOOLS.map(t => ({ name: t.name, description: t.description, parameters: schemaToGemini(t.input_schema) })) }];
