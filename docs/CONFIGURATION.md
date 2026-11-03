# Configuration reference

This is a self-hosted project. Copy .env.example to a private .env, enter your own credentials, then run npm run doctor. The doctor prints only configuration status, never secret values.

## Core

| Variable | Purpose |
| --- | --- |
| PORT, HOST | Web listener. Code defaults to port 3000 on loopback; the sample uses port 3010 |
| NODE_ENV | development for local tests; production for a secured deployment |
| SITE_PASSWORD or AUTH_USERS_B64 | Login; do not use the placeholder password |
| SESSION_SECRET | Unique 32+ character signing secret |
| CORS_ORIGIN | Allowed browser origin; use your real origin when hosting |
| PUBLIC_BASE_URL | Public HTTPS origin used by selected callbacks |

## Official Etsy Open API v3

| Variable | Description |
| --- | --- |
| ETSY_API_KEY | Approved app keystring |
| ETSY_CLIENT_SECRET | Corresponding app shared secret |
| ETSY_SHOP_ID | Authorized primary shop ID |
| ETSY_SHOP_IDS | Optional ID:Name,ID:Name list for UI selection |
| ETSY_ACCESS_TOKEN / ETSY_REFRESH_TOKEN | Optional initial tokens, never commit |
| KV_REST_API_URL / KV_REST_API_TOKEN | Upstash-compatible Redis REST backend needed for revisioned OAuth token state |

**The present token repository requires Redis REST for OAuth exchange and refresh.** Starting the UI without credentials is possible; connecting a shop is not. Do not assume that selecting multiple shops provides isolated per-shop credentials. See [Etsy OAuth](ETSY-OAUTH.md).

### Optional separately installed Etsy API Hub

- ETSY_API_HUB_ENABLED=false is the default.
- If true, set ETSY_API_HUB_ROOT to the absolute path of your independently installed compatible Hub.
- ETSY_API_HUB_TOKEN_SOURCE is legacy (default) or hub.
- With token source hub, set ETSY_API_HUB_CREDENTIAL_FILE to the appropriate private credentials file.

The public API adapter does not assume a fixed path on the original developer's server.

## AI configuration

| Variable | Purpose |
| --- | --- |
| GEMINI_API_KEY, GEMINI_MODEL, GEMINI_IMAGE_MODEL | Google AI |
| ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_FAST_MODEL, CLAUDE_CHAT_MODEL | Claude models |
| EXTERNAL_AI_BASE_URL, EXTERNAL_AI_API_KEY, EXTERNAL_AI_MODEL | External compatible provider |
| EXTERNAL_AI_METHOD, EXTERNAL_AI_TEXT_PATH | Transport/endpoint path |
| EXTERNAL_VISION_MODEL | Optional model with image understanding |
| EXTERNAL_IMAGE_BASE_URL, EXTERNAL_IMAGE_API_KEY, EXTERNAL_IMAGE_MODEL | Separate image endpoint |
| EXTERNAL_AI_IMAGE_PATH, EXTERNAL_IMAGE_ADAPTER, EXTERNAL_IMAGE_REFERENCE_MODE | Explicit image protocol |
| EXTERNAL_AI_PROVIDERS_JSON | Advanced multiple-provider configuration (see api/_external-ai.js) |

Never assume a configured model supports tool calls, vision or image generation. Legacy OMNIROUTE_* names still occur in source for compatibility; they are not required for new users. Read [AI Providers](AI-PROVIDERS.md).

## Optional services

Messages Bridge needs ETSY_MESSAGES_BRIDGE_URL and scoped tokens from a **separate service**, which is not included. MESSAGE_AUTO_TRIGGERS_ENABLED, MESSAGE_TRIGGER_RUNNER_ENABLED, MESSAGE_LEARNING_CAPTURE_ENABLED and MESSAGE_LEARNING_ENABLED default to false.

GPT Actions additionally needs GPT_OAUTH_ISSUER, GPT_OAUTH_CLIENT_ID, GPT_OAUTH_CLIENT_SECRET, GPT_OAUTH_REDIRECT_URIS and signing keys, plus your own HTTPS domain.

Social provider keys (Instagram, Facebook, Pinterest, Buffer, Metricool) are needed only for chosen integrations. AUTOPUBLISH_ENABLED, AUTOPUBLISH, REAL_PUBLISH_RELEASE_APPROVED and SOCIAL_AUTOPUBLISH_OWNER_OPT_IN all default to false.

The code also references legacy tuning/test environment variables. Not all of them are user-facing or appropriate for the sample configuration.

## Preflight

After npm ci and filling out your own .env, run:

    npm run doctor

This does not connect to Etsy or validate an external AI model. Missing optional integrations are warnings, not proof of a broken core installation. See [Deployment](DEPLOYMENT.md).
