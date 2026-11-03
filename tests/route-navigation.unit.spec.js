import { expect, test } from '@playwright/test';
import {
  canonicalRouteUrl,
  routeParamsForPage,
  routeParamsFrom,
} from '../public/utils/router.js';

test('canonical route keeps only the selected page parameters', () => {
  expect(canonicalRouteUrl('messages', {
    tab: 'playbook',
    draft_id: '',
  })).toBe('/#messages?tab=playbook');
  expect(canonicalRouteUrl('messages', {
    tab: 'queue',
    draft_id: 7,
  })).toBe('/#messages?tab=queue&draft_id=7');
});

test('route serialization safely encodes values and ignores empty parameters', () => {
  expect(canonicalRouteUrl('messages', {
    tab: 'inbox',
    conversation_id: 'Vania / 1001',
    preview_id: null,
  })).toBe(
    '/#messages?tab=inbox&conversation_id=Vania+%2F+1001',
  );
});

test('route query parsing supports shareable message deep links', () => {
  expect(routeParamsFrom('?tab=queue&draft_id=91')).toEqual({
    tab: 'queue',
    draft_id: '91',
  });
});

test('message navigation removes a stale social preview id', () => {
  const params = routeParamsForPage('messages', {
    preview_id: 'old-social-post',
    tab: 'playbook',
  });
  expect(params).toEqual({ tab: 'playbook' });
  expect(canonicalRouteUrl('messages', params)).toBe(
    '/#messages?tab=playbook',
  );
});

test('non-serializable workflow state never leaks into a shareable URL', () => {
  expect(canonicalRouteUrl('create', {
    listing_id: 123,
    agentDraft: { generated: { title: 'private workflow state' } },
    attachedImages: ['data:image/png;base64,secret'],
  })).toBe('/#create?listing_id=123');
});
