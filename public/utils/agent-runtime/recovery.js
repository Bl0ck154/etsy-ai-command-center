import { classifyAgentRuntimeError } from './faults.js';

export async function runIdempotentRuntimeRecovery({
  attempts = [],
  accept = () => true,
  classify = classifyAgentRuntimeError,
  context = {},
} = {}) {
  const candidates = Array.isArray(attempts)
    ? attempts.filter(attempt => typeof attempt === 'function')
    : [];
  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    try {
      const value = await candidates[index]();
      if (!accept(value)) throw new Error('Recovery attempt returned incomplete data');
      return { value, attempts_used: index + 1, recovered: index > 0 };
    } catch (error) {
      lastError = error;
    }
  }
  const failure = lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'Runtime recovery failed'));
  failure.runtime_fault = classify(failure, context);
  throw failure;
}
