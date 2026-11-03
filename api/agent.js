// api/agent.js — AI Agent orchestration (Clean Architecture Modularized)
export const maxDuration = 60;

import { requireAuth } from './_auth.js';
import { etsyFetch, getShopId } from './_etsy.js';
import { MODEL } from './_config.js';
import { generateWithExternalAi, hasExternalAiConfigAsync, getExternalAiRuntimeConfig, buildProviderUrl } from './_external-ai.js';
import { clampEtsyTitle } from './_listing-body.js';
import { createBackgroundJob, getBackgroundJob, updateBackgroundJob } from './jobs.js';

const SHOP_ID = getShopId();

const activeAgentStreams = new Set();
let agentShutdownNoticeInstalled = false;

function installAgentShutdownNotice() {
  if (agentShutdownNoticeInstalled || typeof process === 'undefined') return;
  agentShutdownNoticeInstalled = true;
  process.on('SIGTERM', () => {
    for (const res of activeAgentStreams) {
      try {
        res.write('data: ' + JSON.stringify({
          type: 'error',
          error: 'The agent service is restarting. Please retry in a few seconds.',
        }) + '\n\n');
        res.end();
      } catch {}
    }
    setTimeout(() => process.exit(0), 250).unref?.();
  });
}

// Modular architecture imports — only import functions used in this file's body.
// All helpers/vision/schema/dispatch functions are re-exported below via export *.
import { AGENT_SYSTEM, messagesWithContextBrief, selectAgentProvider, loadShopOperatingContext, resolveAgentSystemPrompt, runWithExternal } from './agent/helpers.js';
import { TOOLS, GEMINI_TOOLS } from './agent/tools-schema.js';
import { dispatchTool, executeTool, dispatchToolForTest, limitAgentMessagesForModel, makeState, makeResp } from './agent/tools-dispatch.js';

export * from './agent/helpers.js';
export * from './agent/vision.js';
export * from './agent/tools-schema.js';
export * from './agent/tools-dispatch.js';

// ── Claude runner ──────────────────────────────────────────
async function runWithClaude(messages, context, write = () => {}) {
  const systemPrompt = context?._agentSystemPrompt || AGENT_SYSTEM;
  const modelMessages = messagesWithContextBrief(messages, context);
  const msgs = [];
  for (const m of modelMessages) {
    if (msgs.length && msgs[msgs.length - 1].role === m.role) {
      msgs[msgs.length - 1].content += '\n\n' + String(m.content || '');
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  const s = makeState();
  let maxIter = 25;

  while (maxIter-- > 0) {
    write({ type: 'model', provider: 'claude', model: MODEL.claudeFast });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL.claudeFast, max_tokens: 8192, system: systemPrompt, tools: TOOLS, messages: msgs }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');
    msgs.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn' || data.stop_reason !== 'tool_use') {
      return makeResp(data.content.filter(b => b.type === 'text').map(b => b.text).join(''), s);
    }

    const toolResults = [];
    for (const tb of data.content.filter(b => b.type === 'tool_use')) {
      write({ type: 'tool', name: tb.name, message: tb.input?.progress_message });
      const toolStartedAt = Date.now();
      const result = await dispatchTool(tb.name, tb.input, context, s);
      write({
        type: 'tool_result',
        name: tb.name,
        message: tb.input?.progress_message,
        duration_ms: Date.now() - toolStartedAt,
        status: result?.error ? 'error' : 'ok',
        ...(result?.fault?.code ? { fault_code: result.fault.code, fault_domain: result.fault.fault_domain, required_transition: result.fault.required_transition || null } : {}),
      });
      if (result?.fault?.code) s.debugTrace.push({ type: 'tool_fault', name: tb.name, code: result.fault.code, fault_domain: result.fault.fault_domain, required_transition: result.fault.required_transition || null });
      toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) });
    }
    msgs.push({ role: 'user', content: toolResults });
  }
  return makeResp('Agent reached the iteration limit. Please try a simpler request.', s);
}


// ── Gemini runner ──────────────────────────────────────────
async function runWithGemini(messages, context, write = () => {}, reqOverrides = {}) {
  const systemPrompt = context?._agentSystemPrompt || AGENT_SYSTEM;
  // Gemini needs alternating user/model turns; merge consecutive same-role instead of dropping
  const modelMessages = messagesWithContextBrief(messages, context);
  const raw = modelMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const contents = [];
  for (const m of raw) {
    if (contents.length && contents[contents.length - 1].role === m.role) {
      contents[contents.length - 1].parts.push(...m.parts);
    } else {
      contents.push({ role: m.role, parts: [...m.parts] });
    }
  }
  if (contents.length && contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '.' }] });

  const s = makeState();
  let maxIter = 25;
  let lastText = ''; // accumulate text across iterations in case Gemini mixes text+tool_call in one turn

  // Enforce the requested reasoning model per manifesto (no silent fallbacks to flash/lite)
  const geminiModel = reqOverrides.gemini || MODEL.gemini;
  const reqBody = { system_instruction: { parts: [{ text: systemPrompt }] }, tools: GEMINI_TOOLS, contents, generationConfig: { maxOutputTokens: 16384 } };

  while (maxIter-- > 0) {
    let response, data;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    write({ type: 'model', provider: 'gemini', model: geminiModel });
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 55000);
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: ac.signal });
      data = await response.json();
    } catch (e) {
      clearTimeout(t);
      throw new Error(`Gemini API unavailable (${geminiModel}): ${e.message}`);
    }
    clearTimeout(t);
    if (!response.ok) throw new Error(data.error?.message || 'Gemini API error');

    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No response from Gemini');
    const parts = candidate.content?.parts || [];
    contents.push({ role: 'model', parts });

    // Capture any text Gemini wrote in this turn (even if it also made tool calls)
    const turnText = parts.filter(p => p.text).map(p => p.text).join('');
    if (turnText) lastText = turnText;

    const calls = parts.filter(p => p.functionCall);
    console.log('[agent/gemini] turn: tools=', calls.map(c => c.functionCall.name), 'textLen=', turnText.length, 'pendingBatch=', s.pendingBatchSchedule?.posts?.length ?? 'null');
    if (!calls.length) {
      console.log('[agent/gemini] final return: pendingBatch=', s.pendingBatchSchedule?.posts?.length ?? 'null', 'text=', lastText.slice(0, 60));
      return makeResp(lastText, s);
    }

    const responses = [];
    for (const p of calls) {
      const input = p.functionCall.args || {};
      write({ type: 'tool', name: p.functionCall.name, message: input.progress_message });
      const toolStartedAt = Date.now();
      const result = await dispatchTool(p.functionCall.name, input, context, s);
      write({
        type: 'tool_result',
        name: p.functionCall.name,
        message: input.progress_message,
        duration_ms: Date.now() - toolStartedAt,
        status: result?.error ? 'error' : 'ok',
        ...(result?.fault?.code ? { fault_code: result.fault.code, fault_domain: result.fault.fault_domain, required_transition: result.fault.required_transition || null } : {}),
      });
      if (result?.fault?.code) s.debugTrace.push({ type: 'tool_fault', name: p.functionCall.name, code: result.fault.code, fault_domain: result.fault.fault_domain, required_transition: result.fault.required_transition || null });
      responses.push({ functionResponse: { name: p.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return makeResp(lastText || 'Agent reached the iteration limit. Please try a simpler request.', s);
}

// ── Handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const { messages: rawMessages = [], context = {}, provider = 'auto', model_overrides = {}, turn_id = '' } = req.body || {};
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const trackedTurnId = /^job_agent_[a-z0-9_]+$/i.test(String(turn_id || '')) ? String(turn_id) : '';
  const startedAt = Date.now();
  const messages = limitAgentMessagesForModel(rawMessages);
  if (!messages.length) {
    return res.status(400).json({ error: 'messages required' });
  }

  const hasExternal = await hasExternalAiConfigAsync();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY && !hasExternal) {
    return res.status(503).json({ error: 'No AI provider is configured. Add a supported AI provider key to the server environment.' });
  }

  context.shop_operating_context = context.shop_operating_context || await loadShopOperatingContext();
  context.inventory_by_listing_id = context.inventory_by_listing_id || {};
  context._hasExternal = hasExternal;
  context._agentSystemPrompt = await resolveAgentSystemPrompt();
  context.messages = messages;

  const ownerId = String(req.auth?.user?.id || '');
  context._owner_id = ownerId;
  const existingTurn = trackedTurnId ? await getBackgroundJob(trackedTurnId, ownerId) : null;

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (obj) => {
    const event = trackedTurnId ? { job_id: trackedTurnId, ...obj } : obj;
    try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch {}
    if (!trackedTurnId || obj?.type === 'ping') return;
    if (obj?.type === 'done') {
      updateBackgroundJob(trackedTurnId, {
        status: 'done',
        progress: 100,
        message: 'Agent response ready',
        result: event,
        error: null,
        last_event: event,
      });
      return;
    }
    if (obj?.type === 'error') {
      updateBackgroundJob(trackedTurnId, {
        status: 'error',
        progress: 100,
        message: 'Agent request failed',
        error: obj.error || 'Agent request failed',
        last_event: event,
      });
      return;
    }
    const progress = obj?.type === 'tool_result' ? 60 : obj?.type === 'tool' ? 35 : 15;
    updateBackgroundJob(trackedTurnId, {
      status: 'running',
      progress,
      message: obj?.message || obj?.name || obj?.model || 'Agent is working',
      last_event: event,
    });
  };

  if (existingTurn) {
    if (existingTurn.status === 'done' && existingTurn.result) write(existingTurn.result);
    else if (existingTurn.status === 'error') write({ type: 'error', request_id: requestId, error: existingTurn.error || 'Agent request failed' });
    else write({ type: 'background', request_id: requestId, status: existingTurn.status, message: existingTurn.message || 'Agent is working' });
    res.end();
    return;
  }
  if (trackedTurnId) {
    const createdTurn = createBackgroundJob(trackedTurnId, 'agent_turn', {
      description: messages.at(-1)?.content || '',
      provider,
      // The persisted job retains a redacted, bounded transcript. It is an
      // observability record, not input to the model or a response interceptor.
      messages,
    }, ownerId);
    if (!createdTurn) {
      write({ type: 'error', request_id: requestId, error: 'This agent turn belongs to another user.' });
      res.end();
      return;
    }
    updateBackgroundJob(trackedTurnId, { status: 'running', progress: 5, message: 'Agent request accepted' });
  }
  installAgentShutdownNotice();
  activeAgentStreams.add(res);
  const heartbeat = setInterval(() => write({ type: 'ping' }), 15000);
  let clientClosed = false;
  req.on?.('close', () => {
    clientClosed = true;
    clearInterval(heartbeat);
    console.log('[agent/sse] client closed', requestId, 'afterMs=', Date.now() - startedAt);
  });

  const selectedProvider = selectAgentProvider(provider, messages, context);
  context._provider = selectedProvider;
  context._request_id = requestId;
  console.log('[agent/sse] start', requestId, 'provider=', selectedProvider, 'messages=', messages.length);

  try {
    const rawResult = selectedProvider === 'external'
      ? await runWithExternal(messages, context, write)
      : (selectedProvider === 'claude' && process.env.ANTHROPIC_API_KEY)
      ? await runWithClaude(messages, context, write)
      : await runWithGemini(messages, context, write, model_overrides);
    write({ type: 'done', request_id: requestId, provider: selectedProvider, ...rawResult });
    console.log('[agent/sse] done', requestId, 'afterMs=', Date.now() - startedAt, 'clientClosed=', clientClosed);
  } catch (err) {
    console.error('[agent]', err.message);
    write({ type: 'error', request_id: requestId, error: err.message });
    console.log('[agent/sse] error', requestId, 'afterMs=', Date.now() - startedAt, 'clientClosed=', clientClosed);
  } finally {
    clearInterval(heartbeat);
    activeAgentStreams.delete(res);
  }
  res.end();
}
