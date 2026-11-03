# Etsy AI Command Center

[![Source checks](https://github.com/Bl0ck154/etsy-ai-command-center/actions/workflows/ci.yml/badge.svg)](https://github.com/Bl0ck154/etsy-ai-command-center/actions/workflows/ci.yml) ![MIT License](https://img.shields.io/badge/license-MIT-blue)

**Open-source Etsy shop management dashboard with an actionable AI assistant.**

Manage listings and shop operations in a web dashboard. Ask an AI assistant to inspect shop data, analyze listing images, and prepare changes for your approval. The project also contains optional customer-message and social-campaign workflows.

Built for self-hosting. You provide your own Etsy API credentials, AI providers, and infrastructure.

> Independent community project. Not affiliated with, endorsed by, or certified by Etsy, Inc. Etsy is a trademark of Etsy, Inc.

## What you can do

| Area | What is included | Notes |
| --- | --- | --- |
| Shop dashboard | Listings, inventory, orders, reviews, sales, analytics, settings | Requires your own authorized Etsy access for live data |
| Listing workflows | View, edit, create drafts, bulk operations, media tools | Consequential operations have explicit application checks |
| AI assistant | Tool-calling agent for reading shop context and preparing actions | Configurable provider; approvals required for supported consequential actions |
| Image intelligence | Listing image analysis and image-set planning | Requires a compatible vision or image provider |
| Customer messages | AI reply drafts, approval workflow, optional feedback-based learning | Requires a separate compatible Etsy Messages Bridge; not a standalone Etsy API feature |
| Social operations | Campaign planning, media generation, visual review, queue and manual scheduling | The original autonomous producer is not part of this public release |
| GPT Actions | Scoped OAuth, OpenAPI contracts and controlled Etsy operations | Optional advanced integration |

The UI supports normal manual work. AI is optional and is not required to navigate the dashboard or use ordinary management controls.

## Why this project exists

Most seller tools specialize in SEO, analytics, listing edits or AI copywriting. This project brings management controls and tool-using AI into one workspace. An assistant can inspect available shop context and propose concrete changes while the seller stays in control of important write operations.

The code includes a multi-step social content pipeline: evidence gathering, opportunity selection, creative planning, media generation, quality review, owner review and publish-readiness checks. Its original production-specific autonomous worker was intentionally **not** released here; see `docs/LIMITATIONS.md` for the current boundary.

## Quick start

Requirements: Node.js 22+, npm, your own credentials for Etsy features, and (optionally) an AI provider.

```bash
git clone https://github.com/Bl0ck154/etsy-ai-command-center.git
cd etsy-ai-command-center
npm ci
cp .env.example .env
# Edit .env: replace the sample password and session secret, and add your own provider credentials.
npm start
```

Open `http://localhost:3010`. For production, use HTTPS, proper secrets, and your own authenticated deployment.

The initial UI is not a hosted demo. Live Etsy operations require a properly configured Etsy Open API v3 application and OAuth authorization. Missing optional integrations will not become functional merely by starting the server.

See `docs/QUICKSTART.md` for setup details.

## AI with guardrails

The agent code defines tools for listing searches, image analysis, inventory, orders, shop statistics, approved edits, variation changes, draft preparation and more. Tool availability depends on the connected provider, configuration and the current workflow.

*AI proposals are not an authorization to publish or send.* Customer replies require manager approval; social publishing has separate release and owner gates. Production publishing is **off by default**.

## Repository map

```text
api/          Etsy API, AI agent, GPT Actions, messages, media and social modules
public/       Browser-based dashboard
workers/      Separate worker entry points (not enabled by this repository alone)
tests/        Unit, contract and UI test source
scripts/      General verification and configuration helpers
docs/         Public setup and architecture documentation
```

The server is a modularizing Node.js application with independent worker entry points. Some older internal identifiers still contain `etsy-manager-pro` for compatibility.

## Documentation

- `docs/QUICKSTART.md` — install and configure a local instance
- `docs/FEATURES.md` — manual tools, AI tools and optional workflows
- `docs/ARCHITECTURE.md` — major modules and runtime boundaries
- `docs/INTEGRATIONS.md` — external services and provider requirements
- `docs/LIMITATIONS.md` — incomplete features and usage cautions
- `SECURITY.md` — secret handling and responsible disclosure
- `CONTRIBUTING.md` — local changes and pull requests

## Development

```bash
npm run check
npm run test:unit
```

The basic `check` command is a syntax check, not an end-to-end verification. The full test suite may require additional test fixtures, browser dependencies and configured integration environments.

## Security and privacy

- Never commit `.env`, customer conversations, session tokens, production snapshots, databases or log files.
- Use test accounts or synthetic data in issues and screenshots.
- Keep social publishing and message automation disabled until you have verified every dependency and all required permissions.
- Review Etsy API and platform terms before enabling any data collection, browser integrations or automated actions.

## License

MIT. See `LICENSE`. Contributions are welcome.

This is a new public source snapshot with fresh history, not a public copy of the original private Git commit graph.
