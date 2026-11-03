# Roadmap

Prioritize outside-user reliability over adding feature count.

## P0 — public preview

- [x] Fresh Git history and initial privacy audit
- [x] Independent README, setup guide, sample config and license
- [x] Synthetic, clearly labeled interface illustrations
- [x] Confirm Node 22 dependency installation on a clean hosted runner
- [x] Confirm no-credentials localhost startup and health check (Node 22)
- [x] Present Settings onboarding instead of an empty AI workspace on the first start
- [ ] Audit all optional integration screens for usable unconfigured states
- [x] Verify the full public offline suite in GitHub Actions (1,450 tests)
- [ ] Keep it green across releases and add end-to-end integration coverage
- [ ] Finish removing host-specific assumptions and validate every optional integration
- [x] Make the optional Etsy Hub path explicit and add public setup guides

## P1 — safe standalone operation

- [ ] Tested Etsy OAuth and a synthetic shop management journey
- [ ] Reliable human approval UX for listing edits
- [ ] Visible feature-gating when external services are absent
- [ ] Backup, restore, configuration migrations and upgrades
- [x] Captured screenshots of the static synthetic demo
- [ ] Real UI screenshots from a fully synthetic installation of the actual application

## P2 — integrations

- [ ] Document an independently deployable, policy-compliant message option
- [ ] Finish and test the separate autonomous Social producer
- [ ] Better visual asset review and campaign edit previews
- [ ] More accessible onboarding and mobile-responsive workflows

Please propose specific user workflows in issues.
