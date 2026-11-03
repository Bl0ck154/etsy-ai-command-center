# Security policy

Please do not post working secrets, customer conversations, access tokens, database contents, full server logs or production URLs in public issues.

For suspected vulnerabilities, use GitHub private vulnerability reporting/security advisories if enabled for this repository. Avoid sharing exploit details publicly before maintainers can investigate.

## Operator responsibilities

- Configure independent strong session and OAuth secrets.
- Keep `.env` and persistent data out of Git.
- Review Etsy, AI-provider and social-platform authorizations.
- Default to manual approval for consequential operations.
- Apply updates and restrict external network access.

This repository ships without real credentials or historical private Git commits. A source audit cannot guarantee that a deployment using third-party integrations is secure.
