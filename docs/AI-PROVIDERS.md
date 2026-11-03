# Configuring AI providers

AI capabilities are optional: sellers can navigate the traditional dashboard without an AI key. Etsy-backed data still requires Etsy authorization and storage.

| Provider | Text | Vision | Images | Tool calling |
| --- | --- | --- | --- | --- |
| Gemini | Implemented adapter | Model-dependent | Model-dependent | Model-dependent |
| Claude | Implemented adapter | Model-dependent | Not assumed | Model-dependent |
| External OpenAI-compatible | Configurable endpoint | Separate validation | Explicit adapter only | Must verify actual compatible tool_calls |
| Multiple external providers | Advanced JSON configuration | Per provider | Per provider | Only opt in after testing |

For Gemini, set GEMINI_API_KEY and optionally GEMINI_MODEL. For Claude, set ANTHROPIC_API_KEY and the desired CLAUDE_* model variables.

For an external provider, configure EXTERNAL_AI_BASE_URL, EXTERNAL_AI_API_KEY and EXTERNAL_AI_MODEL to values issued or supported by **your own provider**. EXTERNAL_AI_TEXT_PATH defaults to /v1/chat/completions, so avoid doubling the v1 prefix if the base already includes it. Match the configured endpoint to the provider's API semantics.

Vision, image generation, reference image support and tool calling must each be tested separately. Image models need an adapter and compatible output; a text model alone does not prove image capability.

The current Settings interface retains some historical Responses-style image controls from its original deployment. They are **not a fully generic image setup wizard**. This remains on the public roadmap.

Suggested verification: check Settings → AI provider status; test a synthetic text prompt; test images only if supported; verify a read-only agent tool call; and only then try an owner-approved change.

Do not transmit customer messages or shop data to AI providers unless you have the required platform permissions and lawful data handling.
