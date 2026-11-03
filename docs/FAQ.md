# Frequently asked questions

## Is this made or endorsed by Etsy?

No. AI Command Center is an independent project. Etsy's trademark and API rules apply, and authorization for an Etsy application is separate.

## What is the AI killer feature?

The assistant has tool contracts for inspecting shop records and listing images, then preparing supported changes for owner review. The manual dashboard works as a separate interaction surface. Whether a concrete action is available depends on the AI provider, installed integrations and your Etsy permissions.

## Does the public demo access a real Etsy shop?

No. [The demo](https://bl0ck154.github.io/etsy-ai-command-center/demo/) is static HTML with synthetic data and scripted examples. It performs no network requests to Etsy and changes no live store data.

## Do I need an AI subscription to use the dashboard?

The manual controls do not require an AI model to navigate, but Etsy-backed operations require approved Etsy API credentials and any other dependencies those controls use. AI features need your own provider access and may cost money.

## Can this run for unrelated sellers?

An open-source download does not grant Etsy Commercial Access. Use only a developer application and authorization appropriate to your own use case; multi-seller or commercial deployment may require a separate Etsy review.

## Does it send customer messages automatically?

The public repository does not include the separately operated Messages Bridge. Message drafts and delivery paths require additional integration and owner approval. No message delivery is enabled from the sample environment.

## Is autonomous social marketing ready?

The source contains multiple campaign planning and review modules. The original full autonomous producer is not part of the public package, and publishing is disabled by default.

## Is it production-ready?

Not yet. Clean dependency installation and a basic no-credentials startup on Node 22 have passed hosted smoke checks. Complete feature tests, security review and policy-specific integration validation remain on the [readiness checklist](RELEASE-READINESS.md).

## Why does some source code still contain older technical identifiers?

Some configuration keys and internal names were retained for compatibility with the source's original modules. They do not refer to the original private Git history or include deployed credentials.
