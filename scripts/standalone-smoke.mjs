import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

const origin = 'http://127.0.0.1:' + (process.env.PORT || 3010);
const settings = parse(readFileSync('.env', 'utf8'));
const fail = message => { throw new Error('Standalone smoke: ' + message); };

const health = await fetch(origin + '/healthz');
if (!health.ok) fail('health endpoint failed');
const anonymous = await fetch(origin + '/api/login');
if (!anonymous.ok || (await anonymous.json()).authenticated) fail('anonymous user was authenticated');
const login = await fetch(origin + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: settings.SITE_PASSWORD }),
});
if (!login.ok || !(await login.json()).success) fail('generated password did not allow login');
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
if (!cookie.includes('etsy_mgr_session=')) fail('login cookie missing');
const session = await fetch(origin + '/api/login', { headers: { Cookie: cookie } });
if (!(await session.json()).authenticated) fail('authenticated session not recognized');
const kv = await fetch(origin + '/api/kv?action=ping', { headers: { Cookie: cookie } });
if (!kv.ok || !(await kv.json()).success) fail('embedded KV did not respond through app');
const tokenStatus = await fetch(origin + '/api/auth', { headers: { Cookie: cookie } });
if (!tokenStatus.ok) fail('Etsy token-state endpoint fails without real credentials');
console.log('Standalone setup, login, session, embedded KV and Etsy auth status: PASS');
