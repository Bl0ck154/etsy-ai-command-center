import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PATH = path.resolve('data/embedded-kv.json');
const MAX_REQUEST_BYTES = 3000000;
function active(map, key) {
  const entry = map.get(String(key));
  return entry && entry.expiresAt && entry.expiresAt <= Date.now() ? null : entry || null;
}
function asString(map, key) {
  const entry = active(map, key);
  if (!entry) return null;
  if (entry.type !== 'string') throw new Error('WRONGTYPE');
  return entry.data;
}
function number(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Integer argument required');
  return parsed;
}
function listIndex(index, size) {
  const n = number(index);
  return n < 0 ? Math.max(0, size + n) : n;
}

export function executeEmbeddedCommand(map, name, incoming) {
  const command = String(name || '').toUpperCase();
  const args = incoming.map(String);
  const key = args[0] || '';
  const old = active(map, key);
  if (command === 'PING') return { value: 'PONG', changed: false };
  if (command === 'GET') return { value: asString(map, key), changed: false };
  if (command === 'EXISTS') return { value: Number(Boolean(old)), changed: false };
  if (command === 'DEL') {
    let removed = 0;
    for (const k of args) removed += Number(map.delete(k));
    return { value: removed, changed: removed > 0 };
  }
  if (command === 'SET') {
    if (args.length < 2) throw new Error('SET needs key and value');
    const options = args.slice(2).map(v => v.toUpperCase());
    if (options.includes('NX') && old) return { value: null, changed: false };
    if (options.includes('XX') && !old) return { value: null, changed: false };
    let expiresAt = 0;
    const exIndex = options.indexOf('EX');
    const pxIndex = options.indexOf('PX');
    if (exIndex >= 0) expiresAt = Date.now() + number(args[3 + exIndex]) * 1000;
    if (pxIndex >= 0) expiresAt = Date.now() + number(args[3 + pxIndex]);
    map.set(key, { type: 'string', data: args[1], expiresAt });
    return { value: 'OK', changed: true };
  }
  if (command === 'EXPIRE') {
    if (!old) return { value: 0, changed: false };
    map.set(key, { ...old, expiresAt: Date.now() + number(args[1]) * 1000 });
    return { value: 1, changed: true };
  }
  if (command === 'KEYS') {
    const pattern = key.replace(/\*/g, '.*');
    const re = new RegExp('^' + pattern + '$');
    return { value: [...map.keys()].filter(k => active(map, k) && re.test(k)), changed: false };
  }
  if (command === 'LPUSH') {
    if (old && old.type !== 'list') throw new Error('WRONGTYPE');
    const list = [...(old?.data || [])];
    for (const v of args.slice(1)) list.unshift(v);
    map.set(key, { type: 'list', data: list, expiresAt: old?.expiresAt || 0 });
    return { value: list.length, changed: true };
  }
  if (command === 'LRANGE' || command === 'LTRIM') {
    if (!old) return { value: command === 'LRANGE' ? [] : 'OK', changed: false };
    if (old.type !== 'list') throw new Error('WRONGTYPE');
    const a = listIndex(args[1], old.data.length);
    const b = listIndex(args[2], old.data.length);
    const selected = old.data.slice(a, b + 1);
    if (command === 'LRANGE') return { value: selected, changed: false };
    map.set(key, { ...old, data: selected });
    return { value: 'OK', changed: true };
  }
  if (command === 'EVAL') {
    const script = args[0] || '';
    const count = number(args[1]);
    const keys = args.slice(2, 2 + count);
    const argv = args.slice(2 + count);
    const marker = script.match(/==\s*'(__[a-z_]+_missing__)'/)?.[1];
    const isCas = (count === 1 || count === 5) && Boolean(marker)
      && script.includes("redis.call('GET', KEYS[1])")
      && script.includes("redis.call('SET', KEYS[1], ARGV[2])")
      && (count === 1 || script.includes("redis.call('SET', KEYS[5], ARGV[6])"));
    if (isCas) {
      const current = asString(map, keys[0]);
      if (argv[0] === marker ? current !== null : current !== argv[0]) {
        return { value: 0, changed: false };
      }
      for (let i = 0; i < count; i++) {
        map.set(keys[i], { type: 'string', data: argv[i + 1], expiresAt: 0 });
      }
      return { value: 1, changed: true };
    }
    const isHistoryMigration = count === 1
      && script.includes("redis.call('LRANGE', KEYS[1], 0, -1)")
      && script.includes("redis.call('LSET', KEYS[1], index - 1, ARGV[argument + 1])");
    if (isHistoryMigration) {
      const entry = active(map, keys[0]);
      if (!entry) return { value: 0, changed: false };
      if (entry.type !== 'list') throw new Error('WRONGTYPE');
      const list = [...entry.data];
      let updated = 0;
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < argv.length; j += 2) {
          if (list[i] === argv[j]) {
            list[i] = argv[j + 1];
            updated++;
            break;
          }
        }
      }
      if (updated) map.set(keys[0], { ...entry, data: list });
      return { value: updated, changed: updated > 0 };
    }
    throw new Error('Redis script unsupported by local KV; use Redis REST for advanced workflows');
  }
  throw new Error('Unsupported embedded KV command: ' + command);
}

export async function startEmbeddedKv({ file = process.env.LOCAL_KV_FILE || DEFAULT_PATH } = {}) {
  const filename = path.resolve(file);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  let records = new Map();
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local KV path must be a regular file');
    await fs.chmod(filename, 0o600);
    const payload = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (payload.schema !== 1 || !Array.isArray(payload.entries)) {
      throw new Error('Unsupported embedded KV schema; refusing to overwrite');
    }
    records = new Map(payload.entries);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('hex');
  let queue = Promise.resolve();
  const server = http.createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== 'Bearer ' + token) {
      send(401, { error: 'Unauthorized' });
      return;
    }
    const operation = async () => {
      try {
        let parts;
        if (request.method === 'GET') {
          const url = new URL(request.url, 'http://127.0.0.1');
          parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
        } else if (request.method === 'POST') {
          let body = '';
          for await (const chunk of request) {
            body += chunk.toString('utf8');
            if (body.length > MAX_REQUEST_BYTES) throw new Error('KV request too large');
          }
          parts = JSON.parse(body);
        } else {
          send(405, { error: 'Method not allowed' });
          return;
        }
        if (!Array.isArray(parts) || parts.length < 1) throw new Error('Invalid KV command');
        const copy = new Map(records);
        const result = executeEmbeddedCommand(copy, parts[0], parts.slice(1));
        if (result.changed) {
          const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
          try {
            await fs.writeFile(temporary, JSON.stringify({ schema: 1, entries: [...copy] }), {
              mode: 0o600,
              flag: 'wx',
            });
            await fs.rename(temporary, filename);
            records = copy;
          } finally {
            await fs.rm(temporary, { force: true });
          }
        }
        send(200, { result: result.value });
      } catch (error) {
        send(400, { error: String(error.message || error) });
      }
    };
    queue = queue.then(operation, operation);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    token,
    file: filename,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
