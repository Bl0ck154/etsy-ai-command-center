# Features

## Manual shop management

The browser application includes dashboard, listings, orders, reviews, sales, create/edit listing, media gallery, social, schedule, analytics, competitor research and settings views. Their availability depends on Etsy and provider authentication.

## Tool-using AI assistant

The agent has declared runtime contracts for reading listings, inventory, shop statistics, recent orders, reviews, compliance and image analysis. It can also propose edits, listing image sets, variations, price/inventory updates, listing duplication and social-post scheduling.

Consequential actions use approval or specific workflow gates. Provider support for tool calling is checked separately. The presence of an action contract does not guarantee every model can perform it.

## Listing vision and media

Vision-enabled models can inspect actual listing images, and image planning can prepare media proposals. Generated assets depend on external model support, available references and review gates.

## Customer messages (optional)

A companion Etsy Messages Bridge handles browser-side conversation synchronization and delivery. The Hub contains message draft generation, approval gates, freshness checks and optional learning from confirmed sent replies. Message handling is not part of the standard Etsy Open API operations.

## Social campaign workflow (partial)

The public source includes opportunity selection, creative planning, media generation, media quality checks, owner-review data and publish-readiness logic. A complete autonomous owner-review producer is not included or enabled in this public repository. Manual social interfaces and orchestration code are included for development.

For up-to-date availability and production cautions, see `LIMITATIONS.md`.
