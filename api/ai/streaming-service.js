const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export function createAiStreamingService({
  model,
  generate,
  hasExternalAiConfigAsync,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (!model) throw new TypeError('model dependency is required');
  if (typeof generate !== 'function') throw new TypeError('generate dependency is required');
  if (typeof hasExternalAiConfigAsync !== 'function') {
    throw new TypeError('hasExternalAiConfigAsync dependency is required');
  }

  async function streamRawPrompt(res, params) {
    const claudeKey = env.ANTHROPIC_API_KEY;
    const geminiKey = env.GEMINI_API_KEY;
    const hasExternal = await hasExternalAiConfigAsync();
    if (!claudeKey && !geminiKey && !hasExternal) {
      return res.status(500).json({ error: 'No AI provider configured' });
    }

    if (params.provider === 'external' || (!claudeKey && !geminiKey && hasExternal)) {
      try {
        const data = await generate(
          'audit',
          { ...params, _thinkingLevel: 'NONE' },
          'external',
          false,
        );
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        return res.end();
      } catch (err) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        return res.end();
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const write = data => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const system = params._rawSystem
      || 'You are a helpful Etsy expert. Use **bold** for emphasis, never HTML tags.';

    const streamClaude = async () => {
      const response = await fetchImpl(CLAUDE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model.claudeFast,
          max_tokens: params._maxOutputTokens || 1024,
          system,
          messages: [{ role: 'user', content: params._rawPrompt }],
          stream: true,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Claude ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          let event;
          try { event = JSON.parse(raw); } catch { continue; }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            write({ type: 'delta', text: event.delta.text });
          }
        }
      }
    };

    const streamGemini = async () => {
      const url = `${GEMINI_URL}/${model.gemini}:streamGenerateContent?alt=sse`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: params._rawPrompt }] }],
          generationConfig: {
            maxOutputTokens: params._maxOutputTokens || 4096,
            temperature: 0.7,
            candidateCount: 1,
          },
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Gemini ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(raw); } catch { continue; }
          const text = chunk.candidates?.[0]?.content?.parts?.find(
            part => part.text && !part.thought,
          )?.text || '';
          if (text) write({ type: 'delta', text });
        }
      }
    };

    const preferGemini = params.provider === 'gemini';
    const primary = preferGemini
      ? (geminiKey ? streamGemini : streamClaude)
      : (claudeKey ? streamClaude : streamGemini);
    const fallback = preferGemini
      ? (claudeKey ? streamClaude : null)
      : (geminiKey ? streamGemini : null);

    try {
      await primary();
      write({ type: 'done' });
      return res.end();
    } catch (err) {
      if (fallback) {
        try {
          await fallback();
          write({ type: 'done' });
          return res.end();
        } catch (fallbackError) {
          write({ type: 'error', error: fallbackError.message });
          return res.end();
        }
      }
      write({ type: 'error', error: err.message });
      return res.end();
    }
  }

  return { streamRawPrompt };
}
