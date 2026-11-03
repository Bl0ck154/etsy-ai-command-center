# Testing the public source

## Fast checks

After npm ci:

    npm run verify:source
    npm run doctor

The source check validates syntax and known public-release hygiene patterns. The doctor shows status for the local environment without printing credentials.

## Hosted compatibility gate

The manual GitHub Actions workflow **Clean install and offline smoke** runs:

- npm ci on Node.js 22 in a clean Ubuntu environment
- source syntax and public hygiene checks
- 82 selected offline regression tests (the set can change when tests are added or removed)
- first-run credential generation, localhost boot without Etsy credentials, login, session cookie verification, local KV ping and OAuth status

Successful smoke checks confirm the base executable loads. They **do not prove** Etsy OAuth, all UI pages, write approvals or social publishing work in a new environment.

## Broader unit audit

Use GitHub Actions → **Full offline unit audit** → Run workflow, or run locally:

    npx playwright install chromium
    npm run test:unit:public

This suite is larger and may need browser dependencies, synthetic fixtures or updates to tests inherited from the original deployment. The manual workflow caps failures at 25 to avoid burning CI time on a broken snapshot.

## Public-only test boundaries

The original private deployment had scripts for rolling out services, linking a separate message browser and running an autonomous Social factory. These scripts are deliberately absent from the public source; their deployment-contract tests were removed from the public test suite. Tests for shared request handling, model routing, listing workflows and social application logic remain.

Do not reintroduce production deployment scripts just to make old tests pass. Add portable tests for the actual public behavior instead.

## Test data rules

Use synthetic shop IDs, fake buyer content, placeholder URLs and mocked APIs. Never commit access tokens, customer conversations, real order details, production logs or personal information.

For a feature to be called production-ready, also verify it against an authorized test shop with confirmed scopes and reviewable writes. See [Release readiness](RELEASE-READINESS.md).

## Full-suite audit finding (3 November 2026)

The first complete public offline run passed 1,444 tests, with three legacy-expectation failures. The failing checks assumed an old hardcoded model option or original prompt hashes from before public rebranding. The expected prompt contract is now generated from the sanitized public prompt source, preserving exact-hash checks. The updated standalone-branch audit passed all 1,450 tests on 3 November 2026. See https://github.com/Bl0ck154/etsy-ai-command-center/actions/runs/41637474815. Live Etsy authorization, browser integrations, and write workflows remain outside this offline result.

## First-run browser acceptance

The Standalone browser acceptance workflow installs Chromium on a clean GitHub-hosted runner, generates a private .env, launches the real Node app, signs in using the generated password, verifies the actual Settings and AI pages, and captures screenshots. The workflow uses synthetic data only.

It runs automatically for pull requests affecting public application files and can be launched manually. See the latest runs under GitHub Actions.

## CI scroll-race regression (November 2026)

One rerun of the 1,450-test suite reported a single intermittent failure in the Messages thread scroll-to-bottom expectation (1,449 passed). The application could render a viewed-status update before its initial requestAnimationFrame bottom-scroll, resetting the thread to the top. This is now corrected in the Messages UI, and is covered by the existing browser regression for newest-message positioning and history-prepend anchoring. The fixed branch passed the complete 1,450-test offline audit on 3 November 2026: https://github.com/Bl0ck154/etsy-ai-command-center/actions/runs/41655787228.
