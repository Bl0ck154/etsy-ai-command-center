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
npm run setup
```

The setup command creates private .env credentials, prints your randomly generated login password once and refuses to overwrite an existing file.

The built-in local KV store saves OAuth state under the ignored data/ directory. To connect a real Etsy shop, configure your own approved ETSY_API_KEY, ETSY_CLIENT_SECRET and ETSY_SHOP_ID. Read [Etsy OAuth](ETSY-OAUTH.md) for PKCE and callback setup.

AI is optional. Configure Gemini, Claude or an explicitly compatible external model when needed. Tool calling, vision and image generation are distinct capabilities; read [AI providers](AI-PROVIDERS.md). The external Etsy API Hub is off by default.

## Start

```bash
npm run doctor
npm run check
npm start
```

Open http://127.0.0.1:3010 and log in with the generated password.

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

## More setup guidance

- [Configuration reference](CONFIGURATION.md)
- [Deployment, backup and upgrades](DEPLOYMENT.md)
- [Release readiness](RELEASE-READINESS.md)

The embedded KV adapter supports one application process. Back up its private data file securely. For multi-instance deployment use KV_BACKEND=redis and your own compatible Redis REST endpoint.
