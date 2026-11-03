# Public release readiness

This document is the status of the **public source preview**, not a claim that the application is production-ready.

| Gate | Evidence | Assessment |
| --- | --- | --- |
| New repository history | A new initial commit without private history | Passed |
| Initial privacy cleanup | Sanitized source, examples and deployment exclusion | Point-in-time audit completed; continue monitoring |
| Feature architecture | Manual UI, AI tools and social orchestration exist | Code present, not universal runtime validation |
| Source syntax and privacy guard | Automated checks | CI gate |
| Clean `npm ci` using Node 22 | Hosted CI compatibility gate | Under verification |
| Unit / offline tests | Public smoke subset has 16 tests; full suite still unverified | Partial coverage only |
| Local startup without secrets | GitHub Actions Node 22, no Etsy tokens, `/healthz` | Passed for a basic boot check |
| Etsy OAuth and live writes | Credentials and a permitted shop required | Not validated for outside users |
| Customer messages | Requires a separately deployed Bridge | Not bundled |
| Automated campaign production | Direct autonomous producer incomplete | Not bundled or enabled |
| Full end-to-end tests | Multiple integrations | Not completed |

## P0 work before a production-ready label

- [x] Verify dependency installation on a clean Node.js 22 GitHub Actions host
- [x] Verify the server boots on localhost with no live Etsy account and returns `/healthz` (Node 22)
- [ ] Verify each unconfigured screen displays useful errors instead of failing
- [ ] Run and repair the isolated unit suite
- [ ] Verify standalone Etsy OAuth and manual editing using an approved shop
- [ ] Replace remaining optional hardcoded host-specific paths with portable configuration
- [x] Capture actual screenshots of a separate, synthetic interactive demo (not the live application); connected-app screenshots still needed
- [ ] Define storage backup, upgrade, rollback and restore procedures
- [ ] Validate the Etsy API license, AI-data-processing terms and any public seller app requirements
- [ ] Review security hardening and production networking

## Important limitations

The public source snapshot intentionally excludes original deployment files, runtime data and the independently hosted Messages Bridge. The public demo is static and deliberately has no Etsy connectivity. Some optional paths still expect compatible external infrastructure. A source check only confirms syntax and repository hygiene, not a functioning installation.

See [quick start](QUICKSTART.md), [integrations](INTEGRATIONS.md), [limitations](LIMITATIONS.md) and [roadmap](ROADMAP.md).
