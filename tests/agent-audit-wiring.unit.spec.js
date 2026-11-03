import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const jobsSource = await fs.readFile(new URL('../api/jobs.js', import.meta.url), 'utf8');
const agentAuditSource = await fs.readFile(new URL('../api/jobs/agent-audit.js', import.meta.url), 'utf8');

test('jobs routes Agent audit persistence through the process-safe repository', () => {
  expect(jobsSource).toContain("from './jobs/agent-audit.js'");
  expect(agentAuditSource).toContain("from './agent-audit-repository.js'");
  expect(agentAuditSource).toContain('appendAgentAuditRecord');
  expect(agentAuditSource).toContain('cleanupAgentAuditFiles');
  expect(agentAuditSource).toContain('queueAgentAuditRecord(record');
});

test('jobs no longer owns a process-local Agent audit append implementation', () => {
  expect(jobsSource).not.toContain('__etsyManagerAgentAuditChain');
  expect(jobsSource).not.toContain('fs.appendFile');
  expect(jobsSource).not.toContain('function agentAuditFile(');
  expect(jobsSource).not.toContain('function appendAgentAuditRecord(');
  expect(jobsSource).not.toContain("from 'node:fs/promises'");
});
