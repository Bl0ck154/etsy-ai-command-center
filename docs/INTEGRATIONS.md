# Integrations

All integrations are supplied by the operator. This repository does not ship real tokens or a hosted backend.

| Integration | Used for | Requirement |
| --- | --- | --- |
| Etsy Open API v3 | Authorized seller shop data and changes | Your own approved app and shop OAuth |
| Gemini / Anthropic / other compatible providers | AI reasoning, vision or media | Your own API access; model capabilities differ |
| Compatible key-value backend | Shared state for selected features | Configure independently |
| GPT Actions | Assistant access through scoped OAuth | Separate consent client and correctly configured redirect URIs |
| Etsy Messages Bridge | Conversation state and controlled message delivery | Separate service; evaluate Etsy policy and authorization |
| Pinterest / Instagram / Facebook / Buffer / other social providers | Campaign scheduling and publishing | Per-platform permissions, credentials and explicit publish enablement |

The private operational scripts, production host addresses and the original autonomous Social producer were deliberately excluded from this public snapshot.

Do not enable unofficial browser automation without checking the relevant platform rules and legal obligations.

See [Configuration](CONFIGURATION.md), [Etsy OAuth](ETSY-OAUTH.md), [AI providers](AI-PROVIDERS.md) and [Deployment](DEPLOYMENT.md) for concrete prerequisites and feature boundaries.
