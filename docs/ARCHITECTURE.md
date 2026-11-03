# Architecture

The application is a Node.js service with a browser UI and optional worker entry points.

- `server.js`: composition root and HTTP server.
- `api/`: Etsy access, media, AI routing, tool dispatch, GPT Actions, customer-message integrations and social campaign modules.
- `public/`: vanilla JavaScript application with distinct pages for manual management and AI workflows.
- `workers/`: message trigger and scheduled social-publisher entry points, gated by environment and runtime configuration.
- `tests/`: automated tests and UI fixtures.
- `scripts/`: retained general-purpose setup and verification helpers.

## Service boundaries

The optional Etsy Messages Bridge is a separate service, not bundled here. Do not silently substitute browser scraping for authorized API operations. Social AI content planning and the finite publisher have module-level boundaries, but the direct autonomous producer is unfinished.

Some internal keys, programmatic names and process identifiers retain the historical `etsy-manager-pro` technical identifier. The external project identity is Etsy AI Command Center.

## Operational defaults

Real publishing, automatic trigger execution and owner-review generation are disabled in `.env.example`. A fresh developer installation must not activate these services without explicit configuration and review.
