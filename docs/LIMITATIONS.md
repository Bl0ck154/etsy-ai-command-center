# Known limitations and release boundaries

This is a public source snapshot of an existing self-hosted system. It is not a turn-key SaaS package and has not been independently validated on every clean operating system or hosting stack.

- Some functionality relies on optional external services that are not included here.
- The companion Etsy Messages Bridge is not bundled. Message-related UI and server code can require that dependency.
- The direct autonomous social owner-review producer is not shipped, so descriptions of the full campaign pipeline are architectural, not a claim of unattended out-of-box publishing.
- No account, token, customer history, store owner's personal data, deployment configuration or production database is provided.
- The browser interface contains mature and experimental routes. The presence of a screen or agent tool is not evidence of complete end-to-end readiness.
- Etsy API access, OAuth consent, provider quotas, model tool-calling capabilities and social publishing permissions vary by operator.
- Automatic publishing, messaging triggers and other consequential behaviors must be separately and explicitly enabled after validation.
- The full unit/browser suite may need development fixtures and dependencies; `npm run check` is only a syntax check.

See `QUICKSTART.md` to begin. Report reproducible failures with redacted logs and synthetic test data.
