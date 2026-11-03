import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const sourceFile = process.env.CONFIG_DOCTOR_ENV_FILE || '.env';
const file = resolve(sourceFile);
const values = existsSync(file) ? parse(readFileSync(file)) : {};
const cfg = { ...values, ...process.env };
const have = key => Boolean(String(cfg[key] || '').trim()) && !/^(?:replace-with-|your-own-|your-|example-)/i.test(String(cfg[key]));
const enabled = key => /^(?:1|true|on|yes)$/i.test(String(cfg[key] || ''));
const result = [];
const check = (group, ok, detail) => result.push({ group, status: ok ? 'ready' : 'needs-setup', detail });
const env = String(cfg.NODE_ENV || 'development');
check('local runtime', Number(process.versions.node.split('.')[0]) >= 22, 'Node.js >=22');
check('auth and sessions', have('SITE_PASSWORD') || have('AUTH_USERS_B64'), 'provide your own SITE_PASSWORD or AUTH_USERS_B64');
check('session signing', have('SESSION_SECRET') && String(cfg.SESSION_SECRET).length >= 32, 'set a unique 32+ character SESSION_SECRET');
check('Etsy app', have('ETSY_API_KEY') && have('ETSY_CLIENT_SECRET') && (have('ETSY_SHOP_ID') || have('ETSY_SHOP_IDS')), 'API key, shared secret, shop ID');
const kvBackend = String(cfg.KV_BACKEND || (have('KV_REST_API_URL') ? 'redis' : 'local')).toLowerCase();
const hasRemote = have('KV_REST_API_URL') || have('KV_REST_API_TOKEN');
const kvIsValid = kvBackend === 'local'
  ? !hasRemote
  : kvBackend === 'redis' && have('KV_REST_API_URL') && have('KV_REST_API_TOKEN');
check('OAuth persistence', kvIsValid,
  kvBackend === 'local'
    ? 'single-process embedded storage; keep data/ private and back it up'
    : 'Upstash-compatible Redis REST URL and token');
if (kvBackend === 'local' && env === 'production') {
  result.push({ group: 'local data security', status: 'review-required', detail: 'one process only; protect local storage file and encrypted backups' });
}
const external = have('EXTERNAL_AI_BASE_URL') || have('EXTERNAL_AI_API_KEY') || have('EXTERNAL_AI_MODEL');
check('AI (optional)', have('GEMINI_API_KEY') || have('ANTHROPIC_API_KEY') || (have('EXTERNAL_AI_BASE_URL') && have('EXTERNAL_AI_API_KEY') && have('EXTERNAL_AI_MODEL')), 'at least one fully configured provider');
if (enabled('ETSY_API_HUB_ENABLED')) check('external Hub (optional)', have('ETSY_API_HUB_ROOT') && (!['hub'].includes(String(cfg.ETSY_API_HUB_TOKEN_SOURCE)) || have('ETSY_API_HUB_CREDENTIAL_FILE')), 'explicit Hub path and optional credential file required');
const publishing = enabled('AUTOPUBLISH') || enabled('AUTOPUBLISH_ENABLED') || enabled('MESSAGE_AUTO_TRIGGERS_ENABLED') || enabled('MESSAGE_TRIGGER_RUNNER_ENABLED');
if (publishing) result.push({ group: 'automation', status: 'review-required', detail: 'real-world actions enabled; verify permission and approval gates' });
for (const row of result) console.log(row.status.toUpperCase().padEnd(15) + ' | ' + row.group.padEnd(24) + ' | ' + row.detail);
console.log('Configuration values are intentionally never printed. This check does not contact Etsy or any AI provider.');
if (Number(process.versions.node.split('.')[0]) < 22 || (env === 'production' && (!have('SESSION_SECRET') || !(have('SITE_PASSWORD') || have('AUTH_USERS_B64'))))) process.exitCode = 1;
