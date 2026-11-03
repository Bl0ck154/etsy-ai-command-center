import { expect, test } from '@playwright/test';

import {
  createCreateDraftApplication,
  mergeCreateDraftPatch,
} from '../api/drafts/create-draft-application.js';

const identity = { key: 'create_draft', shopId: 'shop', userId: 'user' };

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function repositoryHarness(initialValue = null) {
  let record = initialValue ? {
    key: identity.key,
    shop_id: identity.shopId,
    user_id: identity.userId,
    updated_at: 1,
    value: clone(initialValue),
  } : null;
  const writes = [];
  let removes = 0;

  return {
    async readDraftRecord() {
      return clone(record);
    },
    async mutateDraftRecord(receivedIdentity, operation) {
      expect(receivedIdentity).toEqual(identity);
      return operation({
        get value() { return clone(record?.value ?? null); },
        async write(nextRecord) {
          record = clone(nextRecord);
          writes.push(clone(nextRecord));
          return clone(record);
        },
        async remove() {
          const existed = Boolean(record);
          record = null;
          removes += 1;
          return existed;
        },
      });
    },
    value: () => clone(record?.value ?? null),
    writes,
    removes: () => removes,
  };
}

function application(harness, timestamp = 1000) {
  return createCreateDraftApplication({
    readDraftRecord: harness.readDraftRecord,
    mutateDraftRecord: harness.mutateDraftRecord,
    now: () => timestamp,
  });
}

test('get returns the persisted value without exposing the repository envelope', async () => {
  const harness = repositoryHarness({ draft_id: 'draft_1', revision: 7 });
  await expect(application(harness).get(identity)).resolves.toEqual({
    status: 200,
    payload: { success: true, data: { draft_id: 'draft_1', revision: 7 } },
  });
});

test('set preserves savedAt, advances revision, and writes repository identity fields', async () => {
  const harness = repositoryHarness({ revision: 12, draft_id: 'old' });
  const result = await application(harness, 1000).set(identity, {
    draft: { draft_id: 'new', savedAt: 44, revision: 20, title: 'Draft' },
    expected_revision: 12,
  });

  expect(result).toEqual({
    status: 200,
    payload: { success: true, data: { savedAt: 44, serverSavedAt: 1000, revision: 1000 } },
  });
  expect(harness.writes).toHaveLength(1);
  expect(harness.writes[0]).toMatchObject({
    key: 'create_draft',
    shop_id: 'shop',
    user_id: 'user',
    updated_at: 1000,
    value: { draft_id: 'new', title: 'Draft', savedAt: 44, serverSavedAt: 1000, revision: 1000 },
  });
});

test('set keeps the exact revision conflict contract and replace_existing bypass', async () => {
  const harness = repositoryHarness({ revision: 9, draft_id: 'current' });
  const app = application(harness, 1000);

  await expect(app.set(identity, { draft: { draft_id: 'next' }, expected_revision: 8 })).resolves.toEqual({
    status: 409,
    payload: {
      error: 'This listing draft changed in another tab or agent action. Reload the current draft before saving.',
      code: 'DRAFT_REVISION_CONFLICT',
      current_revision: 9,
    },
  });
  expect(harness.writes).toHaveLength(0);

  const replaced = await app.set(identity, {
    draft: { draft_id: 'next' },
    expected_revision: 8,
    replace_existing: true,
  });
  expect(replaced.status).toBe(200);
  expect(harness.value().draft_id).toBe('next');
});

test('merge patch changes only supported draft fields', () => {
  expect(mergeCreateDraftPatch(
    { title: 'Keep', listingType: 'download', price: '5', taxonomy_id: 1, untouched: 'yes' },
    {
      title: 'Ignore',
      listingType: 'physical',
      price: '9.50',
      taxonomy_id: 22,
      shipping_profile_id: 33,
      quantity: 4,
      taxonomy_category: '  Portraits  ',
      variations: { properties: [] },
      unsupported: 'ignore',
    },
  )).toEqual({
    title: 'Keep',
    listingType: 'physical',
    price: '9.5',
    taxonomy_id: 22,
    untouched: 'yes',
    variations: { properties: [] },
    shipping_profile_id: 33,
    quantity: 4,
    taxonomy_category: 'Portraits',
  });
});

test('patch is fenced by revision and advances the stored revision on success', async () => {
  const harness = repositoryHarness({ revision: 5, draft_id: 'draft_1', price: '4' });
  const app = application(harness, 2000);

  await expect(app.patch(identity, { patch: { price: 8 }, expected_revision: 4 })).resolves.toEqual({
    status: 409,
    payload: {
      error: 'This listing draft changed after the action card was created. Reload the draft and try again.',
      code: 'DRAFT_REVISION_CONFLICT',
      current_revision: 5,
    },
  });

  const result = await app.patch(identity, { patch: { price: 8 }, expected_revision: 5 });
  expect(result.status).toBe(200);
  expect(result.payload.data).toMatchObject({
    draft_id: 'draft_1',
    price: '8',
    savedAt: 2000,
    serverSavedAt: 2000,
    revision: 2000,
  });
});

test('remove requires the current revision and protects a different active draft id', async () => {
  const harness = repositoryHarness({ revision: 11, draft_id: 'draft_current' });
  const app = application(harness);

  await expect(app.remove(identity, { expected_revision: 10, draft_id: 'draft_current' })).resolves.toMatchObject({
    status: 409,
    payload: { code: 'DRAFT_REVISION_CONFLICT', current_revision: 11 },
  });
  await expect(app.remove(identity, { expected_revision: 11, draft_id: 'draft_old' })).resolves.toMatchObject({
    status: 409,
    payload: { code: 'DRAFT_ID_CONFLICT', current_revision: 11 },
  });
  expect(harness.removes()).toBe(0);

  await expect(app.remove(identity, { expected_revision: 11, draft_id: 'draft_current' })).resolves.toEqual({
    status: 200,
    payload: { success: true, data: { deleted: true } },
  });
  expect(harness.removes()).toBe(1);
});

test('invalid set and patch input fail before entering the repository mutation', async () => {
  const harness = repositoryHarness();
  const app = application(harness);

  await expect(app.set(identity, { draft: [] })).resolves.toEqual({ status: 400, payload: { error: 'draft object required' } });
  await expect(app.patch(identity, { patch: [] })).resolves.toEqual({ status: 400, payload: { error: 'patch object required' } });
  expect(harness.writes).toHaveLength(0);
  expect(harness.removes()).toBe(0);
});
