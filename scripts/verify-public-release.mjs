import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issues = [];
for (const rel of ['.env', '.env.staging', '.env.production', 'data', 'deploy', 'tasks', '.claude', '.agents', '.stitch']) {
  if (fs.existsSync(path.join(root, rel))) issues.push('Private/runtime path present: ' + rel);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (pkg.name !== 'etsy-ai-command-center' || lock.name !== pkg.name || lock.version !== pkg.version) issues.push('Package name/version mismatch');
if (pkg.license !== 'MIT') issues.push('License metadata mismatch');
for (const rel of ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/QUICKSTART.md', 'docs/LIMITATIONS.md', 'docs/RELEASE-READINESS.md', 'docs/assets/dashboard-preview.svg', 'docs/assets/ai-approval-preview.svg', 'docs/demo/index.html']) {
  if (!fs.existsSync(path.join(root, rel))) issues.push('Missing file: ' + rel);
}
const sample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
for (const flag of ['AUTOPUBLISH_ENABLED', 'REAL_PUBLISH_RELEASE_APPROVED', 'MESSAGE_TRIGGER_RUNNER_ENABLED', 'SOCIAL_AUTOPUBLISH_OWNER_OPT_IN']) {
  if (!new RegExp('^'+flag+'=false\\s*$', 'm').test(sample)) issues.push('Unsafe default: ' + flag);
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === '.git' || e.name === 'node_modules') return [];
    const f = path.join(dir, e.name);
    return e.isDirectory() ? walk(f) : e.isFile() ? [f] : [];
  });
}
const patterns = [
 ['possible API key or private key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bgh[pousr]_[a-z0-9]{25,}|\bgithub_pat_[a-z0-9_]{40,}|\bsk-[a-z0-9_-]{24,}|\bAIza[a-z0-9_-]{30,}/i],
 ['production deployment path', /\/home\/admin\/|\/opt\/etsy-manager-pro\/|\.env\.staging\b/],
 ['possible personal email or domain', /[\w.+-]+@(?:gmail|yahoo|hotmail|icloud|bk)\.(?:com|net|ru)|\.pp\.ua\b/i],
];
let count=0;
for (const file of walk(root)) {
  const rel=path.relative(root,file);
  if (rel === 'scripts/verify-public-release.mjs' || !/\.(?:js|mjs|cjs|json|md|css|html|svg|example|yml|yaml|sh|py)$/.test(rel)) continue;
  const bytes=fs.readFileSync(file);
  if (bytes.length > 3000000 || bytes.includes(0)) continue;
  count++;
  const s=bytes.toString('utf8');
  for (const [name,re] of patterns) if (re.test(s)) issues.push(name + ': ' + rel);
}
if (issues.length) {
  for(const issue of issues) console.error(issue);
  process.exitCode=1;
} else {
  console.log('Public-source hygiene passed:',count,'text files checked');
}
