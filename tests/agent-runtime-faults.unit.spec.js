import { test, expect } from '@playwright/test';
import {
  agentModelConversation,
  agentRuntimeUserMessage,
  classifyAgentRuntimeError,
  listingWorkflowSnapshot,
  mayRequestLocalUserAction,
  runIdempotentRuntimeRecovery,
  validateListingImageTransition,
} from '../public/utils/agent-runtime-contract.js';
import { dispatchToolForTest } from '../api/agent/tools-dispatch.js';

const generatedPlan = {
  listing_id: 'draft',
  listing_title: 'Photo restoration service',
  mode: 'add',
  count: 2,
  workflow_id: 'listing_flow_test',
  generated_images: [
    { id: 'image_1', mimeType: 'image/png' },
    { id: 'image_2', mimeType: 'image/png' },
  ],
};

test('application faults never authorize local owner repair', () => {
  const fault = classifyAgentRuntimeError(Object.assign(new Error('storage quota exceeded'), { name: 'QuotaExceededError' }), {
    operation: 'attach_generated_images',
  });
  expect(fault).toMatchObject({
    schema: 'agent_runtime_fault_v1',
    code: 'APP_STORAGE_QUOTA',
    fault_domain: 'application',
    user_action_required: false,
    recovery: 'use_persistent_references',
  });
  expect(mayRequestLocalUserAction(fault)).toBe(false);
  expect(agentRuntimeUserMessage(fault)).not.toMatch(/clear|devtools|delete.*storage|open.*storage|cookie/i);
});

test('runtime events stay out of model-authored conversation history', () => {
  const messages = [
    { role: 'user', content: 'Attach the saved previews.' },
    { role: 'runtime', content: 'Internal workflow event', runtime_fault: { code: 'AGENT_LISTING_DRAFT_REQUIRED' } },
    { role: 'assistant', content: 'I will create the missing listing draft.' },
  ];
  expect(agentModelConversation(messages)).toEqual([messages[0], messages[2]]);
});

test('only explicit user-environment faults may request owner action', () => {
  const fault = classifyAgentRuntimeError(new Error('Session expired. Please log in again.'), {
    operation: 'agent_turn_http',
  });
  expect(fault).toMatchObject({
    code: 'USER_AUTHENTICATION_REQUIRED',
    fault_domain: 'user_environment',
    user_action_required: true,
    recovery: 'reauthenticate',
  });
  expect(mayRequestLocalUserAction(fault)).toBe(true);
});

test('listing workflow blocks attach until draft exists and rejects stale drafts', () => {
  const missingDraft = validateListingImageTransition({ action: 'apply_to_listing', plan: generatedPlan, draft: null });
  expect(missingDraft).toMatchObject({
    ok: false,
    workflow: { state: 'image_previews_ready', has_generated_images: true, has_listing_draft: false },
    fault: {
      code: 'AGENT_LISTING_DRAFT_REQUIRED',
      required_transition: 'generate_listing_content',
      user_action_required: false,
    },
  });

  const matchingDraft = { workflow_id: 'listing_flow_test', generated: { title: 'Ready' } };
  expect(validateListingImageTransition({ action: 'apply_to_listing', plan: generatedPlan, draft: matchingDraft })).toMatchObject({
    ok: true,
    workflow: { state: 'ready_to_attach' },
  });

  const staleDraft = { workflow_id: 'listing_flow_other', generated: { title: 'Wrong product' } };
  expect(validateListingImageTransition({ action: 'apply_to_listing', plan: generatedPlan, draft: staleDraft })).toMatchObject({
    ok: false,
    fault: { code: 'AGENT_STALE_LISTING_WORKFLOW', required_transition: 'select_matching_listing_draft' },
  });
  expect(listingWorkflowSnapshot({ plan: generatedPlan, draft: matchingDraft })).toMatchObject({ workflow_id: 'listing_flow_test', state: 'ready_to_attach' });
});

test('idempotent runtime recovery retries a transient read without mutating the result', async () => {
  let reads = 0;
  const recovered = await runIdempotentRuntimeRecovery({
    attempts: [
      async () => { reads += 1; throw new Error('connection interrupted'); },
      async () => { reads += 1; return [{ id: 'image_1' }]; },
    ],
    accept: images => images.length === 1,
    context: { operation: 'load_agent_generated_images' },
  });
  expect(recovered).toEqual({ value: [{ id: 'image_1' }], attempts_used: 2, recovered: true });
  expect(reads).toBe(2);
});

test('tool contract returns a required transition instead of browser guidance', async () => {
  const blocked = await dispatchToolForTest('act_on_listing_image_plan', {
    action: 'apply_to_listing',
    listing_id: 'draft',
  }, {
    pending_listing_images: generatedPlan,
    current_agent_draft: null,
  });
  expect(blocked.result).toMatchObject({
    status: 'error',
    fault: {
      code: 'AGENT_LISTING_DRAFT_REQUIRED',
      fault_domain: 'workflow',
      user_action_required: false,
      required_transition: 'generate_listing_content',
    },
  });
  expect(JSON.stringify(blocked.result)).not.toMatch(/clear data|devtools|browser storage/i);

  const generated = await dispatchToolForTest('generate_listing_content', {
    target_type: 'create_draft',
    description: 'Photo restoration service with two saved listing previews',
    workflow_action: 'continue',
    workflow_id: 'listing_flow_test',
    after_generation: 'attach_active_image_plan',
  }, {
    pending_listing_images: generatedPlan,
    agent_listing_workflow: { workflow_id: 'listing_flow_test', state: 'image_previews_ready' },
    page_context: {},
  });
  expect(generated.result).toMatchObject({ status: 'generating' });
  expect(generated.state.pendingGenerateListing).toMatchObject({
    workflow_id: 'listing_flow_test',
    workflow_state: 'listing_content_generating',
    after_generation: 'attach_active_image_plan',
  });

  const ready = await dispatchToolForTest('act_on_listing_image_plan', {
    action: 'apply_to_listing',
    listing_id: 'draft',
  }, {
    pending_listing_images: generatedPlan,
    current_agent_draft: { workflow_id: 'listing_flow_test', title: 'Ready listing draft' },
  });
  expect(ready.result).toMatchObject({ status: 'awaiting_client_action', action: 'apply_to_listing', listing_id: 'draft' });
});
