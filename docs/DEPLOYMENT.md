# Deployment, backup and upgrades

Developer-preview guidance, **not** a turnkey production deployment.

Verified: Node.js 22 on a GitHub-hosted Ubuntu runner with clean npm ci, selected offline tests and a no-credentials localhost /healthz check. Other environments, live Etsy OAuth and production migrations are not certified.

## Local development

    git clone https://github.com/Bl0ck154/etsy-ai-command-center.git
    cd etsy-ai-command-center
    npm ci
    npm run setup
    npm run doctor
    npm start

Edit .env before activating real services. The application binds to localhost by default. The sample port is 3010.

## Before internet exposure

- Use a dedicated non-root application identity and HTTPS reverse proxy.
- Configure a unique SESSION_SECRET and secure authentication; never expose the sample password.
- Configure exact CORS/origin values and safe reverse-proxy forwarding.
- Choose persistent storage: the single-process embedded data/embedded-kv.json store works by default; remote Redis REST is an option for shared hosting. Other optional features may have additional state.
- Keep all automatic messaging and publishing switches disabled until individually tested with required permissions.
- Set up backups, restarts, monitoring, storage permissions and incident recovery for your own infrastructure.

## Backup / restore / rollback

Backing up Git alone **does not** back up the working app. Identify every enabled storage location (KV/Redis, OAuth state, local data, external service state), encrypt your backups and test restoration with synthetic data.

For upgrades, pin a source release, review changes to settings and persistent data, and test on a separate instance. Roll back both code and compatible data version together. The original private project's deployment scripts were deliberately excluded; they are not a supported public deployment method.

See [Configuration](CONFIGURATION.md), [Etsy OAuth](ETSY-OAUTH.md), [Integrations](INTEGRATIONS.md) and [Readiness](RELEASE-READINESS.md).

The local KV store is intentionally single-process and does not support arbitrary Redis Lua scripts needed by some optional workers. Keep it private; do not run multiple independent app processes with the same data file. For multi-instance deployment use a compatible Redis REST provider.
