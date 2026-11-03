import { createAgentRuntimeFault } from './faults.js';

export const LISTING_WORKFLOW_SCHEMA = 'agent_listing_workflow_v1';

export function listingWorkflowSnapshot({ plan = null, draft = null, imagesLinked = false } = {}) {
  const generatedImages = Array.isArray(plan?.generated_images) ? plan.generated_images.filter(image => image?.id) : [];
  const hasPlan = Boolean(plan?.listing_id);
  const hasDraft = Boolean(draft?.generated || draft?.title || draft?.description);
  const workflowId = String(plan?.workflow_id || draft?.workflow_id || '').trim();
  let state = 'product_context_ready';
  if (hasPlan) state = 'image_plan_ready';
  if (generatedImages.length) state = 'image_previews_ready';
  if (hasDraft) state = generatedImages.length ? 'ready_to_attach' : 'listing_draft_ready';
  if (draft?.workflow_state === 'images_attached') state = 'images_attached';
  if (imagesLinked) state = 'images_attached';
  return {
    schema: LISTING_WORKFLOW_SCHEMA,
    workflow_id: workflowId,
    state,
    has_image_plan: hasPlan,
    has_generated_images: generatedImages.length > 0,
    generated_image_count: generatedImages.length,
    has_listing_draft: hasDraft,
    images_linked: imagesLinked === true || draft?.workflow_state === 'images_attached',
  };
}

export function validateListingImageTransition({ action, plan = null, draft = null } = {}) {
  const workflow = listingWorkflowSnapshot({ plan, draft });
  const isDraftTarget = !plan?.listing_id || String(plan.listing_id) === 'draft' || String(plan.listing_id) === '0';
  if (action === 'generate_previews') {
    if (workflow.has_generated_images) {
      return { ok: false, workflow, fault: createAgentRuntimeFault({
        code: 'AGENT_IMAGE_PREVIEWS_ALREADY_READY',
        operation: action,
        fault_domain: 'workflow',
        retryable: false,
        workflow_id: workflow.workflow_id,
        state: workflow.state,
        safe_message: 'The current image plan already has generated previews.',
      }) };
    }
    return { ok: true, workflow };
  }
  if (action !== 'apply_to_listing') {
    return { ok: false, workflow, fault: createAgentRuntimeFault({
      code: 'AGENT_UNSUPPORTED_TRANSITION',
      operation: action || 'unknown_listing_transition',
      fault_domain: 'workflow',
      retryable: false,
      workflow_id: workflow.workflow_id,
      state: workflow.state,
      safe_message: 'The requested listing workflow transition is not supported.',
    }) };
  }
  if (plan?.mode !== 'delete_selected' && !workflow.has_generated_images) {
    return { ok: false, workflow, fault: createAgentRuntimeFault({
      code: 'AGENT_IMAGE_PREVIEWS_REQUIRED',
      operation: action,
      fault_domain: 'workflow',
      retryable: true,
      required_transition: 'generate_previews',
      workflow_id: workflow.workflow_id,
      state: workflow.state,
      safe_message: 'Generate the previews first, then apply them to the listing.',
    }) };
  }
  if (isDraftTarget && !workflow.has_listing_draft) {
    return { ok: false, workflow, fault: createAgentRuntimeFault({
      code: 'AGENT_LISTING_DRAFT_REQUIRED',
      operation: action,
      fault_domain: 'workflow',
      retryable: true,
      required_transition: 'generate_listing_content',
      workflow_id: workflow.workflow_id,
      state: workflow.state,
      safe_message: 'Listing content must be generated before these images can be attached.',
    }) };
  }
  if (isDraftTarget && plan?.workflow_id && !draft?.workflow_id) {
    return { ok: false, workflow, fault: createAgentRuntimeFault({
      code: 'AGENT_UNVERIFIED_LISTING_WORKFLOW',
      operation: action,
      fault_domain: 'workflow',
      retryable: true,
      required_transition: 'generate_listing_content',
      workflow_id: workflow.workflow_id,
      state: workflow.state,
      safe_message: 'The current listing draft is not linked to this image workflow.',
    }) };
  }
  if (isDraftTarget && plan?.workflow_id && draft?.workflow_id && String(plan.workflow_id) !== String(draft.workflow_id)) {
    return { ok: false, workflow, fault: createAgentRuntimeFault({
      code: 'AGENT_STALE_LISTING_WORKFLOW',
      operation: action,
      fault_domain: 'workflow',
      retryable: false,
      required_transition: 'select_matching_listing_draft',
      workflow_id: workflow.workflow_id,
      state: workflow.state,
      safe_message: 'These images belong to a different listing workflow than the current draft.',
    }) };
  }
  return { ok: true, workflow };
}
