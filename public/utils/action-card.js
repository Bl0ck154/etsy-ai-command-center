export const RESTORED_ACTION_REASON = 'This action card was restored from chat history after reload and is disabled to prevent stale writes. Ask the agent to prepare a fresh plan.';

export function actionCardState(options = {}) {
  const completed = Boolean(options.completed);
  const disabled = Boolean(options.disabled || options.restored || completed);
  return {
    disabled,
    completed,
    disabledLabel: options.disabledLabel || (completed ? 'Completed' : options.restored ? 'Expired' : 'Disabled'),
    disabledReason: options.disabledReason || (completed ? 'This action has already been completed.' : options.restored ? RESTORED_ACTION_REASON : 'This action is no longer active.'),
  };
}

export function wireActionCard(el, config = {}, options = {}) {
  const state = actionCardState(options);
  const approveBtn = config.approveSelector ? el.querySelector(config.approveSelector) : null;
  const cancelBtn = config.cancelSelector ? el.querySelector(config.cancelSelector) : null;
  const progressEl = config.progressSelector ? el.querySelector(config.progressSelector) : null;

  if (state.disabled) {
    if (approveBtn) {
      approveBtn.disabled = true;
      approveBtn.textContent = state.disabledLabel;
    }
    if (cancelBtn) {
      cancelBtn.disabled = true;
      if (config.hideCancel !== false) cancelBtn.style.display = 'none';
    }
    if (progressEl) progressEl.textContent = state.disabledReason;
    return state;
  }

  if (approveBtn && config.onApprove) approveBtn.onclick = config.onApprove;
  if (cancelBtn && config.onCancel) cancelBtn.onclick = config.onCancel;
  return state;
}
