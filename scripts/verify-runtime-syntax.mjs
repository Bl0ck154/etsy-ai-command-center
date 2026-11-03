import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['api', 'public', 'workers', 'scripts'];
const explicitFiles = ['server.js'];
const errors = [];

function firstExisting(paths) {
  return paths.find(candidate => fs.existsSync(candidate)) || null;
}

const bashExecutable = process.platform === 'win32'
  ? firstExisting([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ]) || 'bash'
  : 'bash';
const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
const pythonSyntaxCheck = [
  'import ast, pathlib, sys',
  "source = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')",
  'ast.parse(source, filename=sys.argv[1])',
].join('; ');

function walk(relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return entry.isFile() ? [relative] : [];
  });
}

const files = [
  ...explicitFiles.filter(file => fs.existsSync(path.join(root, file))),
  ...roots.flatMap(walk),
].filter(file => ['.js', '.mjs', '.cjs', '.py', '.sh'].includes(path.extname(file)));

for (const relative of files) {
  const absolute = path.join(root, relative);
  const ext = path.extname(relative);
  try {
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' });
    } else if (ext === '.sh') {
      execFileSync(bashExecutable, ['-n', absolute], { stdio: 'pipe' });
    } else if (ext === '.py') {
      execFileSync(pythonExecutable, ['-c', pythonSyntaxCheck, absolute], { stdio: 'pipe' });
    }
  } catch (error) {
    const details = [error?.stdout, error?.stderr]
      .filter(Boolean)
      .map(value => value.toString().trim())
      .filter(Boolean)
      .join('\n');
    errors.push(`${relative}${details ? `\n${details}` : ''}`);
  }
}

if (errors.length) {
  process.stderr.write(`Runtime syntax verification failed:\n${errors.map(error => `- ${error}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`Runtime syntax OK: ${files.length} files checked.\n`);
