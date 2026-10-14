// Only a first-party input boundary can mint these records. Tool arguments,
// generated viewport messages and assistant text are never input provenance.
const records = new WeakMap();

export function createVoiceUserTurnTracker({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let current = null;
  const responses = new Map();
  const inputs = new Map();
  const pending = [];
  const waiters = new Set();
  let overflow = false;
  const responseState = (id) => {
    const record = responses.get(id);
    if (!record) return { status: 'untracked', userTurn: undefined };
    if (record !== current || record.retired)
      return { status: 'stale', userTurn: undefined };
    if (record.inputKind === 'speech' && !record.text)
      return { status: 'pending-speech', userTurn: undefined };
    return { status: 'ready', userTurn: record.token };
  };
  const settleWaiter = (waiter, value) => {
    if (!waiters.delete(waiter)) return;
    clearTimer(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve(value);
  };
  const settleWaiters = (forced = null) => {
    for (const waiter of [...waiters]) {
      const value = forced || responseState(waiter.id);
      if (value.status !== 'pending-speech') settleWaiter(waiter, value);
    }
  };
  const reset = () => {
    settleWaiters({ status: 'stale', userTurn: undefined });
    current = null;
    responses.clear();
    inputs.clear();
    pending.length = 0;
    overflow = false;
  };
  const begin = (itemId, text, inputKind) => {
    // Keep pending response reservations for older turns. Their delayed
    // response.created must consume their own slot, never the newer input.
    settleWaiters({ status: 'stale', userTurn: undefined });
    responses.clear();
    const token = Object.freeze({});
    const record = {
      itemId,
      text,
      inputKind,
      token,
      retired: false,
      isCurrent: () => current === record,
    };
    records.set(token, record);
    current = record;
    if (itemId) {
      inputs.set(itemId, record);
      while (inputs.size > 16) inputs.delete(inputs.keys().next().value);
    }
  };
  const reserve = (record, requestId = null) => {
    if (overflow) return;
    pending.push({ record, requestId });
    if (pending.length > 16) {
      current = null;
      pending.length = 0;
      overflow = true;
    }
  };
  return {
    invalidate() {
      settleWaiters({ status: 'stale', userTurn: undefined });
      current = null;
      responses.clear();
    },
    retireCurrentResponse() {
      const record = current;
      settleWaiters({ status: 'stale', userTurn: undefined });
      current = null;
      responses.clear();
      if (!record) return false;
      record.retired = true;
      return true;
    },
    rejectPendingResponse(requestId) {
      if (!requestId) return false;
      const index = pending.findIndex((slot) => slot.requestId === requestId);
      if (index < 0) return false;
      const [{ record }] = pending.splice(index, 1);
      if (record === current) {
        current = null;
        responses.clear();
      }
      return true;
    },
    text(text) {
      begin(null, typeof text === 'string' ? text.trim() : '', 'typed');
    },
    speechStarted(itemId) {
      settleWaiters({ status: 'stale', userTurn: undefined });
      current = null;
      responses.clear();
      if (typeof itemId === 'string' && itemId) begin(itemId, null, 'speech');
    },
    transcript(itemId, text) {
      if (!current || !itemId || current.itemId !== itemId) return false;
      // A final transcript belongs to exactly one live microphone item.
      if (current.text !== null || typeof text !== 'string') return false;
      current.text = text.trim();
      settleWaiters();
      return true;
    },
    commitSpeech(itemId) {
      // A provider input-buffer commit causes one automatic VAD response.
      const record = inputs.get(itemId);
      if (record?.committed) return;
      if (record) record.committed = true;
      reserve(record || null);
    },
    expectResponse(requestId = null) {
      // Called only when the application sends a typed/tool-follow-up response
      // request; generated out-of-band progress responses do not reserve one.
      reserve(current, requestId);
    },
    bindResponse(id) {
      if (!id || overflow) return null;
      const record = pending.shift()?.record;
      if (record?.retired) return 'retired';
      if (!record) return 'untracked';
      if (record !== current) return 'stale';
      responses.set(id, record);
      while (responses.size > 16)
        responses.delete(responses.keys().next().value);
      return 'current';
    },
    waitForResponse(id, { signal, timeoutMs = 5000 } = {}) {
      const state = responseState(id);
      if (state.status !== 'pending-speech') return Promise.resolve(state);
      if (signal?.aborted)
        return Promise.resolve({ status: 'stale', userTurn: undefined });
      return new Promise((resolve) => {
        const waiter = {
          id,
          resolve,
          signal,
          timer: null,
          abort: null,
        };
        waiter.abort = () =>
          settleWaiter(waiter, { status: 'stale', userTurn: undefined });
        waiter.timer = setTimer(
          () =>
            settleWaiter(waiter, {
              status: 'unresolved',
              userTurn: undefined,
            }),
          Math.max(1, Math.min(10_000, Number(timeoutMs) || 5000)),
        );
        signal?.addEventListener('abort', waiter.abort, { once: true });
        waiters.add(waiter);
      });
    },
    forResponse(id) {
      const record = responses.get(id);
      return record === current && record?.text ? record.token : undefined;
    },
    completeResponse(id, hasToolCalls = false) {
      const record = responses.get(id);
      if (hasToolCalls) return;
      responses.delete(id);
      // A function-call response can continue after its tool result. A final
      // answer retires the request, so later automatic turns cannot reuse it.
      if (record && record === current && !hasToolCalls) {
        current = null;
        responses.clear();
      }
    },
    reset,
  };
}

/** Read original text only from an authentic, still-current input token. */
export function readVoiceUserTurnText(token) {
  const record = token && typeof token === 'object' ? records.get(token) : null;
  return record?.isCurrent() && record.text ? record.text : undefined;
}

/** Read the first-party input boundary that minted a current turn token. */
export function readVoiceUserTurnInputKind(token) {
  const record = token && typeof token === 'object' ? records.get(token) : null;
  return record?.isCurrent() ? record.inputKind : undefined;
}
