#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import { parse as parseDotEnv } from 'dotenv';

import { hashAuthPassword } from '../api/_auth.js';

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

const envFile = option('--env');
const primaryId = option('--primary-id', 'illia').trim().toLowerCase();
const primaryName = option('--primary-name', 'Illia').trim();
const secondaryId = option('--secondary-id', 'manager2').trim().toLowerCase();
const secondaryName = option('--secondary-name', 'Manager 2').trim();
const credentialsOut = option('--credentials-out');
const force = process.argv.includes('--force');
const useExistingPrimary = process.argv.includes('--use-existing-primary');

if (!envFile || !credentialsOut) {
  throw new Error('Usage: provision-auth-users.mjs --env <file> --credentials-out <file> [--primary-id illia] [--secondary-id manager2]');
}
if (![primaryId, secondaryId].every(id => /^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) || primaryId === secondaryId) {
  throw new Error('User IDs must be distinct and contain only letters, numbers, dot, underscore, or dash');
}

const original = fs.readFileSync(envFile, 'utf8');
const parsed = parseDotEnv(original);
if (parsed.AUTH_USERS_B64 && !force) throw new Error('AUTH_USERS_B64 is already configured; refusing to overwrite it without --force');
const primaryPassword = useExistingPrimary ? String(parsed.SITE_PASSWORD || '') : crypto.randomBytes(24).toString('base64url');
if (primaryPassword.length < 16) throw new Error('Primary password must contain at least 16 characters');
const secondaryPassword = crypto.randomBytes(24).toString('base64url');
const users = [
  { id: primaryId, name: primaryName, role: 'owner', passwordHash: hashAuthPassword(primaryPassword) },
  { id: secondaryId, name: secondaryName, role: 'viewer', scopes: ['gpt:read'], passwordHash: hashAuthPassword(secondaryPassword) },
];
const encoded = Buffer.from(JSON.stringify(users), 'utf8').toString('base64url');
const nextLine = `AUTH_USERS_B64=${encoded}`;
let next = /^AUTH_USERS_B64=.*$/m.test(original)
  ? original.replace(/^AUTH_USERS_B64=.*$/m, nextLine)
  : `${original.replace(/\s*$/, '\n')}${nextLine}\n`;
next = /^SITE_PASSWORD=.*$/m.test(next)
  ? next.replace(/^SITE_PASSWORD=.*$/m, 'SITE_PASSWORD=')
  : `${next.replace(/\s*$/, '\n')}SITE_PASSWORD=\n`;

fs.writeFileSync(envFile, next, { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(envFile, 0o600);
fs.writeFileSync(credentialsOut, [
  `username=${primaryId}`,
  `password=${primaryPassword}`,
  '',
  `username=${secondaryId}`,
  `password=${secondaryPassword}`,
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
fs.chmodSync(credentialsOut, 0o600);

console.log(`Configured ${users.length} users. Secondary credentials were written to ${credentialsOut} with mode 0600.`);
