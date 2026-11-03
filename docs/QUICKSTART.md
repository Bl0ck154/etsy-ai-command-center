# Quick start

This repository provides source code for a self-hosted application. It does not include a hosted Etsy account, API authorization, AI credits, database credentials, or a production infrastructure stack.

## Requirements

- Node.js 22 or newer
- npm
- A supported operating system and dependencies needed by native npm packages
- Your own Etsy Open API v3 credentials and authorization for live shop features
- An AI API key if you want the AI assistant or media generation

## Install

```bash
git clone https://github.com/Bl0ck154/etsy-ai-command-center.git
cd etsy-ai-command-center
npm ci
cp .env.example .env
```

Edit `.env`. Set a unique, long `SITE_PASSWORD` and a freshly generated random `SESSION_SECRET`. Do not reuse the placeholders from `.env.example`.

Set `ETSY_API_KEY` and your shop's authorization details to use live Etsy operations. Etsy access tokens must belong to an authorized shop/account. Configure the relevant OAuth callback URLs according to your approved Etsy application.

Optionally configure `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or an OpenAI-compatible external AI endpoint. Exact image adapter and tool-calling support differ by provider and model.

## Start

```bash
npm run check
npm start
```

Open `http://localhost:3010`.

If the application reports missing configuration, supply the corresponding credentials for the feature you want to use. Do not copy credentials from another installation.

## Before hosting online

- Terminate HTTPS with a reverse proxy you configure and maintain.
- Use per-user authentication and strong, independent secrets.
- Configure allowed CORS origins for your actual domain.
- Keep private persistent state in an excluded data directory.
- Disable unattended publishing and message automation until separately reviewed.
- Confirm that your Etsy app has the authorization required by your usage.

## Tests

`npm run check` performs lightweight syntax checks. The full unit/browser suites are available in the repository but need additional development dependencies and may include external fixtures.

## Troubleshooting

Some advanced pages depend on separately deployed infrastructure such as a shared KV backend, an Etsy Messages Bridge, or social-media providers. These are optional integrations and are not packaged as turn-key services. See `INTEGRATIONS.md` and `LIMITATIONS.md`.
