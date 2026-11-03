# Connect an Etsy shop

These instructions cover an authorized shop only. This project supplies no API account, tokens, or permissions to manage third-party shops. A live full OAuth journey is not yet certified on a fresh public installation.

1. Register your own Etsy Open API v3 app in the [developer portal](https://www.etsy.com/developers/your-apps). Select the right app type: a seller app for your own shop, or a developer app with applicable permissions for other sellers. Wait for approval when required.
2. Store the app keystring as ETSY_API_KEY and shared secret as ETSY_CLIENT_SECRET, plus the authorized ETSY_SHOP_ID, in your private .env. Never publish the secret.
3. Create an Upstash-compatible Redis REST store and set KV_REST_API_URL and KV_REST_API_TOKEN. The current revisioned OAuth token repository depends on it.
4. For Etsy OAuth2, register the **exact** callback URI used by the application. Public HTTPS is recommended/required for hosted callbacks; callback strings must match Etsy's registration. Use OAuth Authorization Code with PKCE S256, cryptographic random state and single-use code verifier. Request only the scopes needed for your operations.
5. Start the server, then select Settings → Etsy API credentials → Connect Etsy. The button opens /etsy-auth.html?env=1; check this page's actual callback and register it with Etsy. Authorize the account that owns your shop.
6. Back in Settings, choose Test connection. Confirm the returned shop name matches your authorized shop. Do not attempt write operations until verified in a controlled environment.

Troubleshooting: check the app's approval status, keystring/secret, exact callback, scope grants, KV persistence, access/refresh token validity, and whether ETSY_API_HUB_ENABLED was unintentionally set true.

Tokens and buyer data must never be posted in GitHub issues, client logs or screenshots. Multi-shop UI selection does not yet prove isolated token persistence for different sellers.

Official guides:
- [Authentication, PKCE and exact redirect URI matching](https://developers.etsy.com/documentation/essentials/oauth2/)
- [Etsy API developer quickstart](https://developers.etsy.com/documentation/tutorials/quickstart/)
- [Etsy API reference and operation scopes](https://developers.etsy.com/documentation/reference)

Implementation references: public/etsy-auth.html, public/pages/settings.js, api/etsy-auth/oauth-client.js, api/etsy-auth/token-runtime.js, api/_etsy-token-state.js.
