# Keeping public and private installations aligned

The open-source project and the original self-hosted deployment have **separate Git histories**. The public repository was created as a clean source snapshot; Git commit dates or version numbers alone do not prove that deployed functionality is newer or older.

## Safe update process

1. Identify the exact source revision and deployed artifact that contain the intended functional change.
2. Compare source file **content**, not just Git commit timestamps. Note any public-only patches (setup portability, sanitized examples, tests and documentation).
3. Transfer the minimal functional changes to a clean feature branch in the public repository. Never import a private Git history, runtime data, logs, browser profiles, .env files or server-specific deployment scripts.
4. Scan added files, test fixtures and documentation for shop identifiers, buyer messages, private URLs, credentials, internal service paths and other sensitive data. Use synthetic test data.
5. Verify changed tests. Update instructions for standalone operation and keep unpublished integrations clearly marked optional or unavailable.
6. Run source CI, the hosted clean-install smoke and the relevant offline suite.
7. Merge a reviewed pull request, then record the public release version separately from the deployed private revision.

## Public patches that must survive sync

- Optional Etsy API Hub has no hidden absolute-path default.
- OAuth requires explicit KV storage configuration.
- Automated publication and message triggers remain disabled by default.
- Public tests must not refer to excluded server deployment scripts.
- Demo screenshots contain synthetic data and must never be replaced with identifiable shop/customer captures.
- README and feature tables should reflect what the public install can actually run.

If the private app's functionality changes significantly, document which modules and capabilities are still unavailable in the standalone release. Do not claim parity until the integration tests demonstrate it.
