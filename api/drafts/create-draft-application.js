function applicationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} dependency is required`);
  return value;
}

function mutationResult(status, payload) {
  return { status, payload };
}

export function mergeCreateDraftPatch(current, patch) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = { ...base };
  if (patch?.listingType === 'physical' || patch?.listingType === 'download') {
    next.listingType = patch.listingType;
  }
  if (patch?.variations === null || (patch?.variations && typeof patch.variations === 'object' && !Array.isArray(patch.variations))) {
    next.variations = patch.variations;
  }
  const price = Number(patch?.price);
  if (Number.isFinite(price) && price >= 0.20) next.price = String(price);
  for (const field of ['taxonomy_id', 'shipping_profile_id', 'readiness_state_id', 'return_policy_id', 'shop_section_id']) {
    const value = Number(patch?.[field]);
    if (Number.isInteger(value) && value > 0) next[field] = value;
  }
  for (const field of ['processing_min', 'processing_max', 'quantity']) {
    const value = Number(patch?.[field]);
    if (Number.isInteger(value) && value > 0) next[field] = value;
  }
  if (typeof patch?.taxonomy_category === 'string' && patch.taxonomy_category.trim()) {
    next.taxonomy_category = patch.taxonomy_category.trim().slice(0, 240);
  }
  return next;
}

export function createCreateDraftApplication({
  readDraftRecord,
  mutateDraftRecord,
  now = Date.now,
} = {}) {
  const readRecord = requiredFunction(readDraftRecord, 'readDraftRecord');
  const mutateRecord = requiredFunction(mutateDraftRecord, 'mutateDraftRecord');
  const currentTime = requiredFunction(now, 'now');

  async function get(identity) {
    const draft = (await readRecord(identity))?.value || null;
    return mutationResult(200, { success: true, data: draft });
  }

  async function set(identity, source = {}) {
    const draft = source.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return mutationResult(400, { error: 'draft object required' });
    }

    return mutateRecord(identity, async context => {
      const current = context.value;
      const expectedRevision = Number(source.expected_revision);
      if (current && Number.isFinite(expectedRevision) && expectedRevision >= 0
        && Number(current.revision || 0) !== expectedRevision
        && source.replace_existing !== true) {
        return mutationResult(409, {
          error: 'This listing draft changed in another tab or agent action. Reload the current draft before saving.',
          code: 'DRAFT_REVISION_CONFLICT',
          current_revision: Number(current.revision || 0),
        });
      }

      const timestamp = Number(currentTime());
      if (!Number.isFinite(timestamp)) throw applicationError('DRAFT_TIME_INVALID', 'Draft application clock returned an invalid timestamp');
      const value = {
        ...draft,
        savedAt: Number(draft.savedAt) || timestamp,
        serverSavedAt: timestamp,
        revision: Math.max(Number(current?.revision || 0) + 1, Number(draft.revision) || 0, timestamp),
      };
      await context.write({
        key: identity.key,
        shop_id: identity.shopId,
        user_id: identity.userId,
        updated_at: timestamp,
        value,
      });
      return mutationResult(200, {
        success: true,
        data: { savedAt: value.savedAt, serverSavedAt: timestamp, revision: value.revision },
      });
    });
  }

  async function patch(identity, source = {}) {
    const patchValue = source.patch;
    if (!patchValue || typeof patchValue !== 'object' || Array.isArray(patchValue)) {
      return mutationResult(400, { error: 'patch object required' });
    }

    return mutateRecord(identity, async context => {
      const current = context.value;
      if (!current) return mutationResult(404, { error: 'Create draft not found' });
      const expectedRevision = Number(source.expected_revision);
      if (Number.isFinite(expectedRevision) && expectedRevision >= 0 && Number(current.revision || 0) !== expectedRevision) {
        return mutationResult(409, {
          error: 'This listing draft changed after the action card was created. Reload the draft and try again.',
          code: 'DRAFT_REVISION_CONFLICT',
          current_revision: Number(current.revision || 0),
        });
      }

      const timestamp = Number(currentTime());
      if (!Number.isFinite(timestamp)) throw applicationError('DRAFT_TIME_INVALID', 'Draft application clock returned an invalid timestamp');
      const value = {
        ...mergeCreateDraftPatch(current, patchValue),
        savedAt: timestamp,
        serverSavedAt: timestamp,
        revision: Math.max(Number(current.revision) + 1 || 0, timestamp),
      };
      await context.write({
        key: identity.key,
        shop_id: identity.shopId,
        user_id: identity.userId,
        updated_at: timestamp,
        value,
      });
      return mutationResult(200, { success: true, data: value });
    });
  }

  async function remove(identity, source = {}) {
    return mutateRecord(identity, async context => {
      const current = context.value;
      if (!current) return mutationResult(200, { success: true, data: { deleted: false } });
      const expectedRevision = Number(source.expected_revision);
      const currentRevision = Number(current.revision || 0);
      if (!Number.isFinite(expectedRevision) || expectedRevision < 0 || currentRevision !== expectedRevision) {
        return mutationResult(409, {
          error: 'This listing draft changed before it could be removed. Reload it before trying again.',
          code: 'DRAFT_REVISION_CONFLICT',
          current_revision: currentRevision,
        });
      }
      const expectedDraftId = String(source.draft_id || '').trim();
      const currentDraftId = String(current.draft_id || '').trim();
      if (expectedDraftId && currentDraftId && expectedDraftId !== currentDraftId) {
        return mutationResult(409, {
          error: 'A different listing draft is now active and was not removed.',
          code: 'DRAFT_ID_CONFLICT',
          current_revision: currentRevision,
        });
      }
      await context.remove();
      return mutationResult(200, { success: true, data: { deleted: true } });
    });
  }

  return Object.freeze({
    get,
    set,
    patch,
    remove,
  });
}
