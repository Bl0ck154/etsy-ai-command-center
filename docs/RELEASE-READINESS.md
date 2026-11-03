# Public release readiness

This document is the status of the **public source preview**, not a claim that the application is production-ready.

| Gate | Evidence | Assessment |
| --- | --- | --- |
| New repository history | A new initial commit without private history | Passed |
| Initial privacy cleanup | Sanitized source, examples and deployment exclusion | Point-in-time audit completed; continue monitoring |
| Feature architecture | Manual UI, AI tools and social orchestration exist | Code present, not universal runtime validation |
| Source syntax and privacy guard | Automated checks | CI gate |
| Clean `npm ci` using Node 22 | Hosted CI compatibility gate | Under verification |
| Unit / offline tests | Suites included in `tests/` | Verify and repair suite before relying on them |
| Local startup without secrets | Fresh environment | Not independently proven yet |
| Etsy OAuth and live writes | Credentials and a permitted shop required | Not validated for outside users |
| Customer messages | Requires a separately deployed Bridge | Not bundled |
| Automated campaign production | Direct autonomous producer incomplete | Not bundled or enabled |
| Full end-to-end tests | Multiple integrations | Not completed |

## P0 work before a production-ready label

- [ ] Verify dependency installation on a clean Node.js 22 host
- [ ] Verify server boots with no live account and handles unconfigured features clearly
- [ ] Run and repair the isolated unit suite
- [ ] Verify standalone Etsy OAuth and manual editing using an approved shop
- [ ] Replace remaining optional hardcoded host-specific paths with portable configuration
- [ ] Capture actual UI screenshots from a synthetic test instance
- [ ] Define storage backup, upgrade, rollback and restore procedures
- [ ] Validate the Etsy API license, AI-data-processing terms and any public seller app requirements
- [ ] Review security hardening and production networking

## Important limitations

The public source snapshot intentionally excludes original deployment files, runtime data and the independently hosted Messages Bridge. Some optional paths still expect compatible external infrastructure. A source check only confirms syntax and repository hygiene, not a functioning installation.

See [quick start](QUICKSTART.md), [integrations](INTEGRATIONS.md), [limitations](LIMITATIONS.md) and [roadmap](ROADMAP.md).
