import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const destination = path.resolve('.env');
const example = await fs.readFile(path.resolve('.env.example'), 'utf8');
const password = crypto.randomBytes(22).toString('base64url');
const secret = crypto.randomBytes(48).toString('base64url');
const replaceKey = (source, key, value) => {
  const lines = source.split('\n');
  const index = lines.findIndex(line => line.startsWith(key + '='));
  if (index < 0) throw new Error('Missing .env.example key: ' + key);
  lines[index] = key + '=' + value;
  return lines.join('\n');
};
let output = replaceKey(example, 'SITE_PASSWORD', password);
output = replaceKey(output, 'SESSION_SECRET', secret);
output = replaceKey(output, 'KV_BACKEND', 'local');
try {
  await fs.writeFile(destination, output, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('An .env file already exists. Nothing was overwritten.');
    process.exit(1);
  }
  throw error;
}
console.log('Created private .env with secure random credentials and local KV enabled.');
console.log('Login password (shown only once): ' + password);
console.log('Open http://127.0.0.1:3010 after npm start.');
console.log('To use a real Etsy shop, see docs/ETSY-OAUTH.md and add your own approved API credentials.');
