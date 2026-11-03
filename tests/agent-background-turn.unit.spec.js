import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('server-tracked agent jobs retain progress and one final result', async () => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-agent-turn-'));
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-agent-audit-'));
  const previousJobsDir = process.env.JOBS_DIR;
  const previousAuditDir = process.env.AGENT_AUDIT_DIR;
  process.env.JOBS_DIR = jobsDir;
  process.env.AGENT_AUDIT_DIR = auditDir;
  try {
    const jobs = await import(`../api/jobs.js?agent-turn=${Date.now()}`);
    const id = `job_agent_test_${Date.now().toString(36)}`;
    jobs.createBackgroundJob(id, 'agent_turn', {
      description: 'Keep working after reload',
      provider: 'external',
      messages: [
        { role: 'user', content: 'Create a listing for a photo restoration service.' },
        { role: 'assistant', content: 'I will prepare the listing draft.' },
        { role: 'user', content: 'Email owner@example.com, call +1 (555) 123-4567, use token=secret-value, Authorization="quoted-secret", and xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.' },
      ],
    });
    jobs.updateBackgroundJob(id, {
      status: 'running',
      progress: 35,
      message: 'Looking up listing details',
      last_event: { type: 'tool', name: 'get_listing_details' },
    });

    let stored = jobs.publicBackgroundJob(await jobs.getBackgroundJob(id));
    expect(stored).toMatchObject({
      id,
      type: 'agent_turn',
      status: 'running',
      progress: 35,
      last_event: { type: 'tool', name: 'get_listing_details' },
    });
    expect(stored.input_summary.agent_conversation).toMatchObject({
      schema: 'agent_turn_transcript_v1',
      message_count: 3,
    });
    expect(stored.input_summary.agent_conversation.messages[0]).toMatchObject({ role: 'user', content: 'Create a listing for a photo restoration service.' });
    expect(stored.input_summary.agent_conversation.messages[1]).toMatchObject({ role: 'assistant', content: 'I will prepare the listing draft.' });
    const persistedTranscript = JSON.stringify(stored.input_summary.agent_conversation);
    expect(persistedTranscript).toContain('[REDACTED_EMAIL]');
    expect(persistedTranscript).toContain('[REDACTED_PHONE]');
    expect(persistedTranscript).toContain('token=[REDACTED]');
    expect(persistedTranscript).toContain('Authorization=[REDACTED]');
    expect(persistedTranscript).toContain('[REDACTED_TOKEN]');
    expect(persistedTranscript).not.toContain('owner@example.com');
    expect(persistedTranscript).not.toContain('secret-value');
    expect(persistedTranscript).not.toContain('quoted-secret');

    const result = {
      type: 'done',
      job_id: id,
      provider: 'external',
      message: 'Finished for owner@example.com using token=secret-value.',
      debug_trace: [
        { type: 'model_turn', provider: 'external', provider_id: 'primary', model: 'gpt-test', step: 1, duration_ms: 120, tool_names: ['generate_listing_content'] },
        { type: 'tool_call', name: 'generate_listing_content', step: 1, duration_ms: 40, status: 'ok' },
      ],
    };
    jobs.updateBackgroundJob(id, {
      status: 'done',
      progress: 100,
      message: 'Agent response ready',
      result,
      last_event: result,
    });
    stored = jobs.publicBackgroundJob(await jobs.getBackgroundJob(id));
    expect(stored.status).toBe('done');
    expect(stored.result).toEqual(result);
    jobs.recordAgentRuntimeFault(id, {
      code: 'APP_STORAGE_QUOTA',
      operation: 'attach_generated_images',
      fault_domain: 'application',
      retryable: true,
      user_action_required: false,
      recovery: 'use_persistent_references',
      workflow_id: 'listing_flow_test',
    });
    await expect.poll(async () => {
      const files = fs.readdirSync(auditDir);
      if (!files.length) return [];
      return fs.readFileSync(path.join(auditDir, files[0]), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    }).toHaveLength(3);
    const auditRecords = fs.readFileSync(path.join(auditDir, fs.readdirSync(auditDir)[0]), 'utf8').trim().split('\n').map(JSON.parse);
    expect(auditRecords.map(record => record.event)).toEqual(['accepted', 'completed', 'runtime_fault']);
    expect(auditRecords[1]).toMatchObject({
      schema: 'agent_turn_audit_v1',
      result: {
        provider: 'external',
        debug_trace: [
          { type: 'model_turn', model: 'gpt-test', tool_names: ['generate_listing_content'] },
          { type: 'tool_call', name: 'generate_listing_content', status: 'ok' },
        ],
      },
    });
    expect(auditRecords[2]).toMatchObject({
      source: 'client_runtime',
      fault: {
        code: 'APP_STORAGE_QUOTA',
        fault_domain: 'application',
        user_action_required: false,
        recovery: 'use_persistent_references',
        workflow_id: 'listing_flow_test',
      },
    });
    const persistedAudit = JSON.stringify(auditRecords);
    expect(persistedAudit).toContain('[REDACTED_EMAIL]');
    expect(persistedAudit).toContain('token=[REDACTED]');
    expect(persistedAudit).not.toContain('owner@example.com');
    expect(persistedAudit).not.toContain('secret-value');
  } finally {
    if (previousJobsDir === undefined) delete process.env.JOBS_DIR;
    else process.env.JOBS_DIR = previousJobsDir;
    if (previousAuditDir === undefined) delete process.env.AGENT_AUDIT_DIR;
    else process.env.AGENT_AUDIT_DIR = previousAuditDir;
    fs.rmSync(jobsDir, { recursive: true, force: true });
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
});
