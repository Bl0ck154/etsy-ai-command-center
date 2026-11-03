import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const apiEntry = fs.readFileSync(new URL('../api/messages.js', import.meta.url), 'utf8');
const httpHandler = fs.readFileSync(new URL('../api/messages/http-handler.js', import.meta.url), 'utf8');
const composition = fs.readFileSync(new URL('../api/messages/composition.js', import.meta.url), 'utf8');
const readActions = fs.readFileSync(new URL('../api/messages/http-read-actions.js', import.meta.url), 'utf8');
const writeActions = fs.readFileSync(new URL('../api/messages/http-write-actions.js', import.meta.url), 'utf8');
const conversationApplication = fs.readFileSync(new URL('../api/messages/conversation-application.js', import.meta.url), 'utf8');
const deliveryApplication = fs.readFileSync(new URL('../api/messages/draft-delivery-application.js', import.meta.url), 'utf8');
const generationApplication = fs.readFileSync(new URL('../api/messages/draft-generation-application.js', import.meta.url), 'utf8');
const lifecycleApplication = fs.readFileSync(new URL('../api/messages/draft-lifecycle-application.js', import.meta.url), 'utf8');

test('Messages public entry and HTTP handler stay thin', () => {
  expect(apiEntry.trim()).toBe("export { default } from './messages/http-handler.js';");
  expect(httpHandler).toContain("from './composition.js'");
  expect(httpHandler).toContain('handleGet(req, res, action)');
  expect(httpHandler).toContain('handlePost(req, res, action)');
  expect(httpHandler).not.toContain('switch (action)');
  expect(httpHandler).not.toContain('bridgeRequest(');
  expect(httpHandler.split('\n').length).toBeLessThanOrEqual(20);
});

test('composition owns dependency wiring while GET and POST adapters own action switches', () => {
  expect(composition).toContain("from './conversation-application.js'");
  expect(composition).toContain("from './runtime-application.js'");
  expect(composition).toContain("from './draft-delivery-application.js'");
  expect(composition).toContain("from './draft-generation-application.js'");
  expect(composition).toContain("from './draft-lifecycle-application.js'");
  expect(composition).toContain("from './http-read-actions.js'");
  expect(composition).toContain("from './http-write-actions.js'");
  expect(composition).not.toContain('switch (action)');
  expect(readActions).toContain('switch (action)');
  expect(writeActions).toContain('switch (action)');
});

test('HTTP adapters do not reimplement application state machines', () => {
  for (const source of [readActions, writeActions]) {
    expect(source).not.toContain('function draftFreshness(');
    expect(source).not.toContain('function withDraftDeliveryLock(');
    expect(source).not.toContain('function allBridgeConversationMessages(');
    expect(source).not.toContain('function runtimeStatus(');
    expect(source).not.toContain('generateMessageDraft({');
  }
});

test('conversation, delivery, generation and lifecycle policies have one implementation owner', () => {
  expect(conversationApplication).toContain('async function allBridgeConversationMessages(');
  expect(conversationApplication).toContain('async function refreshedConversationForDraft(');
  expect(deliveryApplication).toContain('function draftFreshness(');
  expect(deliveryApplication).toContain('async function approveAndSendDraft(');
  expect(deliveryApplication).toContain("headers: { 'Idempotency-Key': operationId }");
  expect(generationApplication).toContain('async function previewDraft(');
  expect(generationApplication).toContain('async function generateDraft(');
  expect(generationApplication).toContain('async function createManualDraft(');
  expect(lifecycleApplication).toContain('async function approveDraft(');
  expect(lifecycleApplication).toContain('async function sendApprovedDraft(');
  expect(lifecycleApplication).toContain('async function skipDraft(');
  expect(lifecycleApplication).toContain('async function blockDraft(');
});
