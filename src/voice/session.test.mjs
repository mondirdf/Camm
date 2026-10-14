import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';
import { createVoiceSession } from './session.js';
import { realtimeSessionEvent } from './realtimeEvents.js';
import { createVoiceCommands } from './sessionCommands.js';
import { VoiceCardControls } from './voiceCard.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  runner = async (name, args) => ({ ok: true, name, ...args }),
  signal,
) {
  let hooks;
  const sent = [];
  let stops = 0;
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter(options) {
      hooks = options;
      return {
        start() {
          hooks.emit({ type: 'state', state: 'listening' });
        },
        stop() {
          stops++;
          hooks.emit({ type: 'state', state: 'idle' });
        },
        sendText(text) {
          sent.push(['text', text]);
          return true;
        },
        sendMapEvent(event) {
          sent.push(['map', event]);
          return true;
        },
      };
    },
  });
  return {
    session,
    hooks,
    sent,
    get stops() {
      return stops;
    },
  };
}

test('alternate protocol shares session events and action execution without Realtime', async () => {
  const f = fixture();
  const events = [];
  f.session.subscribe(() => {
    throw new Error('observer');
  });
  const unsubscribe = f.session.subscribe((event) => events.push(event));
  await f.session.start();
  assert.equal(f.session.isActive(), true);
  f.hooks.emit({
    type: 'transcript',
    role: 'user',
    text: 'London',
    final: true,
  });
  assert.deepEqual(
    await f.hooks.runAction('fly_to_location', { query: 'London' }),
    { ok: true, name: 'fly_to_location', query: 'London' },
  );
  f.hooks.emit({ type: 'completion', status: 'completed' });
  f.session.sendText('Next');
  f.session.sendMapEvent({
    type: 'map_annotation_outline',
    status: 'resolved',
  });
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'state',
      'state',
      'transcript',
      'action-call',
      'action-result',
      'action-settled',
      'completion',
    ],
  );
  assert.equal(f.sent.length, 2);
  const actionEvents = events.filter((event) =>
    event.type.startsWith('action-'),
  );
  assert.equal(typeof actionEvents[0].actionId, 'number');
  assert.deepEqual(
    actionEvents.map((event) => event.actionId),
    Array(3).fill(actionEvents[0].actionId),
  );
  unsubscribe();
  f.session.stop();
  assert.equal(f.session.state, 'idle');
  await f.session.start();
  assert.equal(f.session.state, 'listening');
  f.session.destroy();
  assert.equal(f.session.disposed, true);
  assert.equal(f.session.sendText('stale'), false);
});

test('stop, interruption and lifetime abort cancel actions and suppress stale results', async () => {
  for (const cancel of ['stop', 'interruption', 'lifetime']) {
    const result = deferred();
    const lifetime = new AbortController();
    let observed;
    const f = fixture(async (_name, _args, options) => {
      observed = options;
      return result.promise;
    }, lifetime.signal);
    const events = [];
    f.session.subscribe((event) => events.push(event));
    await f.session.start();
    const pending = f.hooks.runAction('fly_to_location', {});
    if (cancel === 'stop') f.session.stop();
    if (cancel === 'interruption')
      f.hooks.emit({ type: 'interruption', reason: 'user-speech' });
    if (cancel === 'lifetime') lifetime.abort();
    assert.equal(observed.signal.aborted, true);
    assert.equal(observed.isCurrent(), false);
    result.resolve({ ok: true });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(
      events.some((event) => event.type === 'action-result'),
      false,
    );
    f.session.destroy();
  }
});

test('caller cancellation and sibling actions preserve independent ownership', async () => {
  const first = deferred();
  const f = fixture(async (name) =>
    name === 'first' ? first.promise : { ok: true },
  );
  await f.session.start();
  const signal = new AbortController();
  const pending = f.hooks.runAction('first', {}, { signal: signal.signal });
  signal.abort();
  assert.deepEqual(await f.hooks.runAction('second', {}), { ok: true });
  first.resolve({ ok: true });
  await assert.rejects(pending, { name: 'AbortError' });
  f.session.destroy();
});

test('session action IDs remain unique across same-name calls, interruption and restart', async (t) => {
  const pending = [];
  const f = fixture(
    (_name, _args, options) =>
      new Promise((resolve) => pending.push({ resolve, options })),
  );
  t.after(() => f.session.destroy());
  const events = [];
  f.session.subscribe((event) => events.push(event));
  await f.session.start();
  const first = f.hooks.runAction('get_weather', {});
  const sibling = f.hooks.runAction('get_weather', {});
  pending[1].resolve({ ok: true, sibling: true });
  await sibling;
  f.hooks.emit({ type: 'interruption' });
  const next = f.hooks.runAction('get_weather', {});
  pending[0].resolve({ ok: true, stale: true });
  await assert.rejects(first, { name: 'AbortError' });
  pending[2].resolve({ ok: true, next: true });
  await next;
  f.session.stop();
  await f.session.start();
  const restarted = f.hooks.runAction('get_weather', {});
  pending[3].resolve({ ok: true, restarted: true });
  await restarted;
  const calls = events.filter((event) => event.type === 'action-call');
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map((event) => event.actionId)).size, 4);
  assert.equal(
    calls.every((event) => Number.isInteger(event.actionId)),
    true,
  );
  for (const call of calls) {
    const ownEvents = events.filter(
      (event) => event.actionId === call.actionId,
    );
    assert.deepEqual(
      ownEvents.map((event) => event.type),
      [
        'action-call',
        ...(call === calls[0] ? [] : ['action-result']),
        'action-settled',
      ],
    );
  }
  assert.equal(
    pending[2].options.isCurrent(),
    false,
    'stop revoked the earlier generation',
  );
  assert.equal(pending[3].options.signal.aborted, false);
});

test('stale connect failure cannot stop a replacement session', async () => {
  let reject;
  let calls = 0;
  let hooks;
  const session = createVoiceSession({
    runner: async () => {},
    createAdapter(options) {
      hooks = options;
      return {
        start() {
          if (++calls === 1)
            return new Promise((_resolve, fail) => {
              reject = fail;
            });
          hooks.emit({ type: 'state', state: 'listening' });
        },
        stop() {},
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  const old = session.start();
  session.stop();
  await session.start();
  reject(new Error('old connection failed'));
  await old;
  assert.equal(session.state, 'listening');
  session.destroy();
});

test('wire events project only normalized transcript, interruption and completion fields', () => {
  assert.deepEqual(
    realtimeSessionEvent({
      type: 'response.output_audio_transcript.delta',
      delta: 'Hello',
      item_id: 'i',
      response_id: 'r',
      extra: 'ignored',
    }),
    {
      type: 'transcript',
      role: 'assistant',
      text: 'Hello',
      final: false,
      itemId: 'i',
      responseId: 'r',
    },
  );
  assert.deepEqual(
    realtimeSessionEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Go',
    }),
    {
      type: 'transcript',
      role: 'user',
      text: 'Go',
      final: true,
      itemId: null,
    },
  );
  assert.equal(
    realtimeSessionEvent({ type: 'response.output_text.done', text: 'Done' })
      .final,
    true,
  );
  assert.equal(
    realtimeSessionEvent({ type: 'input_audio_buffer.speech_started' }).type,
    'interruption',
  );
  assert.equal(
    realtimeSessionEvent({
      type: 'response.done',
      response: { id: 'r', status: 'cancelled' },
    }).status,
    'cancelled',
  );
  assert.equal(
    realtimeSessionEvent({
      type: 'session.created',
      session: { secret: 'excluded' },
    }),
    null,
  );
});

test('common button and annotation bindings work with an alternate adapter and clean up', async () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const button = new EventTarget();
    button.setAttribute = () => {};
    const voiceSettingsButton = new EventTarget();
    voiceSettingsButton.attributes = {};
    voiceSettingsButton.setAttribute = (name, value) => {
      voiceSettingsButton.attributes[name] = String(value);
    };
    voiceSettingsButton.focus = () => {};
    const voiceSettingsPanel = new EventTarget();
    voiceSettingsPanel.hidden = true;
    voiceSettingsPanel.attributes = {};
    voiceSettingsPanel.setAttribute = (name, value) => {
      voiceSettingsPanel.attributes[name] = String(value);
    };
    const ownerDocument = { activeElement: null };
    voiceSettingsPanel.ownerDocument = ownerDocument;
    const inactivitySelect = new EventTarget();
    inactivitySelect.value = '';
    let settingsFocusCalls = 0;
    inactivitySelect.focus = () => {
      settingsFocusCalls++;
      ownerDocument.activeElement = inactivitySelect;
    };
    const inactivityCustomInput = new EventTarget();
    inactivityCustomInput.value = '5';
    inactivityCustomInput.setAttribute = () => {};
    inactivityCustomInput.setCustomValidity = () => {};
    let removed = 0;
    let subscribed = null;
    let calls = 0;
    let emitSession;
    const events = [];
    const ui = {
      button,
      root: {
        dataset: {},
        remove() {
          removed++;
        },
      },
      status: {},
      detail: {},
      tierButton: {},
      costValue: {},
      helpDetail: {},
      errorDetail: {},
      errorHint: {},
      voiceSettingsButton,
      voiceSettingsPanel,
      voiceSettingsClose: new EventTarget(),
      inactivitySelect,
      inactivityCustomRow: { hidden: true },
      inactivityCustomInput,
      inactivityNote: {},
    };
    const lifetime = new AbortController();
    const controls = createVoiceCommands({
      runner: async () => {
        calls++;
        return { ok: true };
      },
      signal: lifetime.signal,
      createControl: () => ui,
      annotations: {
        onOutlineEvent(listener) {
          subscribed = listener;
          return () => {
            subscribed = null;
          };
        },
      },
      createSession({ emit, runAction }) {
        emitSession = emit;
        return {
          async start() {
            emit({ type: 'state', state: 'listening', detail: 'Ready' });
            await runAction('fly_to_location', { query: 'London' });
          },
          stop() {
            emit({ type: 'state', state: 'idle' });
          },
          sendText() {},
          sendMapEvent(event) {
            events.push(event);
          },
        };
      },
    });
    button.dispatchEvent(new Event('click'));
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(calls, 1);
    assert.equal(ui.tierButton.hidden, true);
    assert.equal(ui.costValue.hidden, true);
    assert.equal(ui.helpDetail.textContent, 'Activate to toggle voice');
    assert.equal(ui.status.textContent, 'LISTENING');
    assert.equal(ui.detail.textContent, 'Ready');
    assert.equal(controls.setVoiceSettingsOpen(true), true);
    assert.equal(voiceSettingsPanel.hidden, false);
    const foreground = () =>
      voiceSettingsPanel.attributes['data-voice-settings-front'];
    assert.equal(foreground(), 'true');
    for (const event of [
      {
        type: 'transcript',
        role: 'user',
        text: 'Show voice settings',
        final: true,
      },
      { type: 'action-call', name: 'set_panel_open', actionId: 2 },
      {
        type: 'action-result',
        name: 'set_panel_open',
        actionId: 2,
        result: { ok: true },
      },
      { type: 'action-settled', name: 'set_panel_open', actionId: 2 },
      {
        type: 'transcript',
        role: 'assistant',
        text: 'Voice settings are open.',
        final: true,
      },
      { type: 'state', state: 'speaking' },
      { type: 'completion', status: 'completed' },
      { type: 'reply-complete', status: 'completed' },
      { type: 'state', state: 'listening' },
    ]) {
      emitSession(event);
      assert.equal(
        foreground(),
        'true',
        `${event.type} belongs to the current turn`,
      );
    }
    const focusCallsBeforeTurn = settingsFocusCalls;
    emitSession({ type: 'interruption', reason: 'user-speech' });
    assert.equal(
      foreground(),
      'false',
      'the next turn returns voice text to the foreground',
    );
    assert.equal(voiceSettingsPanel.hidden, false);
    assert.equal(voiceSettingsButton.attributes['aria-expanded'], 'true');
    assert.equal(ownerDocument.activeElement, inactivitySelect);
    assert.equal(settingsFocusCalls, focusCallsBeforeTurn);
    controls.setVoiceSettingsOpen(true);
    assert.equal(
      foreground(),
      'true',
      'a repeated show request fronts the open panel',
    );
    controls.setVoiceSettingsOpen(false);
    assert.equal(foreground(), 'false');
    assert.equal(controls.deferVoiceSettingsUntilCockpitExit(), true);
    globalThis.window.dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', {
        detail: { active: false },
      }),
    );
    await Promise.resolve();
    assert.equal(
      voiceSettingsPanel.hidden,
      false,
      'a confirmed or manual Cockpit exit opens the pending panel',
    );
    assert.equal(
      foreground(),
      'true',
      'a deferred explicit request still fronts settings',
    );
    controls.setVoiceSettingsOpen(false);
    assert.equal(controls.deferVoiceSettingsUntilCockpitExit(), true);
    emitSession({
      type: 'state',
      state: 'error',
      detail: 'Gemini Live connection is expiring.',
      recovery: 'Start voice again for a fresh token and a new conversation.',
    });
    assert.equal(
      ui.errorHint.textContent,
      'Start voice again for a fresh token and a new conversation.',
    );
    globalThis.window.dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', {
        detail: { active: false },
      }),
    );
    await Promise.resolve();
    assert.equal(
      voiceSettingsPanel.hidden,
      true,
      'terminal voice state cancels the pending Cockpit exit intent',
    );
    emitSession({ type: 'state', state: 'error', detail: 'Network failed' });
    assert.equal(
      ui.errorHint.textContent,
      'Check microphone permission and network access, then try again.',
    );
    emitSession({ type: 'state', state: 'listening', detail: 'Ready' });
    subscribed({ status: 'resolved' });
    assert.deepEqual(events, [
      { type: 'map_annotation_outline', status: 'resolved' },
    ]);
    button.dispatchEvent(new Event('click'));
    assert.equal(controls.state, 'idle');
    assert.equal(voiceSettingsPanel.hidden, true);
    assert.equal(foreground(), 'false');
    assert.equal(voiceSettingsButton.attributes['aria-expanded'], 'false');
    lifetime.abort();
    assert.equal(subscribed, null);
    assert.equal(removed, 1);
    button.dispatchEvent(new Event('click'));
    assert.equal(calls, 1);
  } finally {
    globalThis.window = previous;
  }
});

test('late actions cannot run after stop and failed startup closes the adapter', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
  });
  await f.session.start();
  f.session.stop();
  await assert.rejects(f.hooks.runAction('fly_to_location', {}), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
  f.session.destroy();
  let stopped = 0;
  const session = createVoiceSession({
    runner: async () => {},
    createAdapter({ emit }) {
      return {
        start() {
          emit({ type: 'state', state: 'connecting' });
          throw new Error('Connection refused');
        },
        stop() {
          stopped++;
          emit({ type: 'state', state: 'idle' });
        },
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  await session.start();
  assert.equal(session.state, 'error');
  assert.equal(stopped, 1);
  session.destroy();
});

test('action events carry the call id; progress after cancellation is dropped', async () => {
  let report;
  const f = fixture(async (name, args, options) => {
    options.progress({ step: 'resolve', label: 'Zilker' });
    report = options.progress;
    return { ok: true };
  });
  const events = [];
  f.session.subscribe((event) => events.push(event));
  await f.session.start();
  await f.hooks.runAction('annotate_map', {}, { callId: 'call_7' });
  const actionEvents = events.filter(
    (e) => e.type.startsWith('action-') || e.type === 'progress',
  );
  assert.deepEqual(
    actionEvents.map((e) => [e.type, e.callId]),
    [
      ['action-call', 'call_7'],
      ['progress', 'call_7'],
      ['action-result', 'call_7'],
      ['action-settled', 'call_7'],
    ],
  );
  f.hooks.emit({ type: 'interruption' });
  report({ step: 'outline' });
  assert.equal(events.filter((e) => e.type === 'progress').length, 1);
});

test('a rejected current action settles its card and preserves the rejection', async () => {
  const failure = new Error('Unknown panel');
  const f = fixture(async () => {
    throw failure;
  });
  let card = initialVoiceCardState();
  const events = [];
  f.session.subscribe((event) => {
    events.push(event);
    card = reduceVoiceCard(card, event);
  });
  await f.session.start();
  await assert.rejects(
    f.hooks.runAction(
      'set_panel_open',
      { panelId: 'missing' },
      { callId: 'failed-call' },
    ),
    (error) => error === failure,
  );
  f.hooks.emit({ type: 'completion', status: 'completed' });
  assert.equal(voiceCardView(card).busy, false);
  assert.equal(card.steps[0].status, 'failed');
  const result = events.find((event) => event.type === 'action-result');
  assert.equal(result.callId, 'failed-call');
  assert.equal(result.result.ok, false);
  f.session.destroy();
});

test('a late rejection cannot settle a newer turn card', async () => {
  let reject;
  const f = fixture(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const events = [];
  f.session.subscribe((event) => events.push(event));
  await f.session.start();
  const pending = f.hooks.runAction(
    'set_panel_open',
    {},
    { callId: 'old-call' },
  );
  f.hooks.emit({ type: 'interruption', reason: 'user-speech' });
  reject(new Error('late failure'));
  await assert.rejects(pending, /late failure/);
  assert.equal(
    events.some((event) => event.type === 'action-result'),
    false,
  );
  f.session.destroy();
});

test('a supplied adapter retains settings and cost controls without provider switching', () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  const button = new EventTarget();
  button.setAttribute = () => {};
  const ui = {
    root: { dataset: {}, remove() {} },
    button,
    status: {},
    detail: {},
    providerField: { hidden: true, remove() {} },
    providerSelect: new EventTarget(),
    tierButton: { hidden: true },
    costValue: { hidden: true },
    costSettings: { hidden: true },
  };
  let controls;
  try {
    controls = createVoiceCommands({
      runner: async () => ({ ok: true }),
      createControl: () => ui,
      createSession: () => ({
        capabilities: { costControls: true, pushToTalk: true },
        start() {},
        stop() {},
        sendText() {},
        sendMapEvent() {},
      }),
    });
    assert.equal(ui.providerField.hidden, false);
    assert.equal(ui.providerSelect.hidden, true);
    assert.equal(ui.costSettings.hidden, false);
    assert.equal(ui.tierButton.hidden, false);
    assert.equal(ui.costValue.hidden, false);
  } finally {
    controls?.session.destroy();
    globalThis.window = previous;
  }
});

for (const teardown of ['remove-ui', 'lifetime-abort', 'already-aborted']) {
  test(`Voice preview preference binds to the session card and cleans up on ${teardown}`, async (t) => {
    const previous = globalThis.window;
    globalThis.window = new EventTarget();
    const lifetime = new AbortController();
    if (teardown === 'already-aborted') lifetime.abort();
    const enabled = [];
    const cardEvents = [];
    let destroyed = 0;
    let removed = 0;
    let emitSession;
    const values = new Map([['godsEyeView.voice.previewEnabled', 'false']]);
    const writes = [];
    const previewInput = new EventTarget();
    previewInput.checked = true;
    const button = new EventTarget();
    button.setAttribute = () => {};
    const ui = {
      root: { dataset: {}, remove: () => removed++ },
      button,
      status: {},
      detail: {},
      card: {},
      voicePreviewInput: previewInput,
    };
    let controls;
    t.after(() => {
      controls?.session.destroy();
      globalThis.window = previous;
    });
    controls = createVoiceCommands({
      signal: lifetime.signal,
      runner: async () => ({ ok: true }),
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem(key, value) {
          values.set(key, value);
          writes.push([key, value]);
        },
      },
      createControl: () => ui,
      createCard: () => ({
        setEnabled: (value) => enabled.push(value),
        handle: (event) => cardEvents.push(event),
        destroy: () => destroyed++,
      }),
      createSession: ({ emit }) => {
        emitSession = emit;
        return {
          start: () => emit({ type: 'state', state: 'listening' }),
          stop() {},
          sendText() {},
          sendMapEvent() {},
        };
      },
    });
    const change = (value) => {
      previewInput.checked = value;
      previewInput.dispatchEvent(new Event('change'));
    };
    assert.equal(previewInput.checked, false);
    assert.deepEqual(
      enabled,
      [false],
      'the persisted choice initializes the created card',
    );
    if (teardown !== 'already-aborted') {
      await controls.session.start();
      const transcript = {
        type: 'transcript',
        role: 'assistant',
        text: 'Current reply',
        final: true,
      };
      emitSession(transcript);
      assert.ok(
        cardEvents.includes(transcript),
        'disabled cards still receive session events',
      );
      change(true);
      assert.deepEqual(enabled, [false, true]);
      assert.equal(values.get('godsEyeView.voice.previewEnabled'), 'true');
      controls.session.stop();
      assert.equal(destroyed, 0, 'ordinary Stop keeps the settings binding');
      change(false);
      assert.deepEqual(enabled, [false, true, false]);
      if (teardown === 'remove-ui') controls.stop({ removeUi: true });
      else lifetime.abort();
    }
    assert.equal(controls.session.disposed, true);
    assert.equal(destroyed, 1);
    assert.equal(removed, 1);
    const before = {
      enabled: enabled.length,
      writes: writes.length,
      events: cardEvents.length,
    };
    change(true);
    emitSession({ type: 'interruption' });
    assert.deepEqual(
      {
        enabled: enabled.length,
        writes: writes.length,
        events: cardEvents.length,
      },
      before,
      'retired checkboxes and sessions cannot change the card or its preference',
    );
  });
}

function panelOrderFixture(
  t,
  { runner = async () => ({ ok: true }), sharedPanel = false } = {},
) {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  const doc = { activeElement: null };
  let focusCalls = 0;
  function node(id, className = '') {
    const element = new EventTarget();
    Object.assign(element, {
      id,
      className,
      hidden: false,
      isConnected: true,
      dataset: {},
      textContent: '',
      children: [],
      ownerDocument: doc,
      parentElement: null,
      style: Object.freeze({ left: '10px', top: '20px' }),
    });
    const attributes = new Map();
    element.setAttribute = (name, value) => attributes.set(name, String(value));
    element.getAttribute = (name) => attributes.get(name) ?? null;
    element.classList = {
      contains: (name) => element.className.split(' ').includes(name),
    };
    element.contains = (candidate) => {
      for (let current = candidate; current; current = current.parentElement)
        if (current === element) return true;
      return false;
    };
    element.focus = () => {
      focusCalls++;
      doc.activeElement = element;
    };
    element.remove = () => {
      element.isConnected = false;
      element.parentElement = null;
    };
    element.replaceChildren = (...children) => {
      element.children = children;
    };
    element.append = (...children) => element.children.push(...children);
    element.matches = () => false;
    return element;
  }
  doc.createElement = (tag) => node(tag);
  const dock = node('command-dock');
  const root = node('gev-voice-control');
  const providerField = node('provider-field', 'gev-voice-provider-field');
  root.parentElement = providerField.parentElement = dock;
  const nodes = new Map();
  root.querySelector = (selector) => {
    if (!nodes.has(selector)) {
      const element = node(
        selector.slice(1),
        selector === '#gev-voice-card' ? 'gev-voice-card' : '',
      );
      element.parentElement = root;
      nodes.set(selector, element);
    }
    return nodes.get(selector);
  };
  const panel = node('settings-panel', 'gev-voice-settings-panel');
  panel.parentElement = providerField;
  const customInput = node('custom');
  customInput.value = '5';
  customInput.setCustomValidity = () => {};
  const ui = {
    root,
    providerField,
    card: root.querySelector('#gev-voice-card'),
    button: node('button'),
    status: {},
    detail: {},
    voiceSettingsPanel: panel,
    voiceSettingsButton: node('settings-button'),
    voiceSettingsClose: node('close'),
    voicePreviewInput: node('preview-input'),
    inactivitySelect: node('inactivity'),
    inactivityCustomInput: customInput,
  };
  if (sharedPanel) {
    for (const name of [
      'voicePanel',
      'previewPanel',
      'previewTab',
      'settingsTab',
      'previewEmpty',
    ])
      ui[name] = node(name);
    ui.voicePanel.parentElement = root;
    ui.previewPanel.parentElement = ui.voicePanel;
    panel.parentElement = ui.voicePanel;
    ui.previewTab.parentElement = ui.settingsTab.parentElement = ui.voicePanel;
    ui.previewEmpty.parentElement = ui.card.parentElement = ui.previewPanel;
  }
  ui.inactivitySelect.parentElement = panel;
  const values = new Map();
  const writes = [];
  const starts = [];
  const stops = [];
  const cardTimers = new Map();
  let nextCardTimer = 1;
  let hooks;
  const controls = createVoiceCommands({
    runner,
    createControl: () => ui,
    createCard: ({ root, onRender }) =>
      new VoiceCardControls({
        root,
        onRender,
        setTimer(fn) {
          const id = nextCardTimer++;
          cardTimers.set(id, () => {
            cardTimers.delete(id);
            fn();
          });
          return id;
        },
        clearTimer: (id) => cardTimers.delete(id),
      }),
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem(key, value) {
        values.set(key, value);
        writes.push([key, value]);
      },
    },
    createSession(options) {
      hooks = options;
      return {
        start(settings) {
          starts.push(settings);
          hooks.emit({ type: 'state', state: 'listening' });
        },
        stop(settings) {
          stops.push(settings);
        },
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  t.after(() => {
    controls.session.destroy();
    globalThis.window = previous;
  });
  controls.setVoiceSettingsOpen(true);
  hooks.emit({ type: 'interruption' });
  return {
    controls,
    ui,
    dock,
    doc,
    hooks,
    starts,
    stops,
    writes,
    values,
    cardTimers,
    focusCalls: () => focusCalls,
    foreground: () => panel.getAttribute('data-voice-settings-front'),
  };
}

test('all four explicit panel orders report actual state without other mutations', (t) => {
  const f = panelOrderFixture(t);
  const focus = f.doc.activeElement;
  const focusCalls = f.focusCalls();
  const state = f.controls.session.state;
  for (const [panelId, position, frontPanelId] of [
    ['voice-settings', 'front', 'voice-settings'],
    ['voice-preview', 'front', 'voice-preview'],
    ['voice-preview', 'back', 'voice-settings'],
    ['voice-settings', 'back', 'voice-preview'],
  ]) {
    assert.deepEqual(f.controls.setVoicePanelOrder(panelId, position), {
      ok: true,
      panelId,
      position,
      changed: true,
      frontPanelId,
      settingsOpen: true,
      previewVisible: true,
      previewEnabled: true,
    });
    assert.equal(
      f.controls.setVoicePanelOrder(panelId, position).changed,
      false,
    );
    assert.equal(f.foreground(), String(frontPanelId === 'voice-settings'));
    assert.equal(f.ui.card.hidden, false);
    assert.equal(f.ui.voiceSettingsPanel.hidden, false);
    assert.equal(f.doc.activeElement, focus);
    assert.equal(f.focusCalls(), focusCalls);
    assert.equal(f.controls.session.state, state);
    assert.deepEqual(f.starts, []);
    assert.deepEqual(f.stops, []);
    assert.deepEqual(f.writes, []);
    assert.equal(f.controls.voiceCard.enabled, true);
  }
});

test('explicit order survives passive events and interruptions until newer open/close or terminal intent', async (t) => {
  const f = panelOrderFixture(t);
  await f.controls.session.start();
  f.controls.setVoicePanelOrder('voice-settings', 'front');
  for (const event of [
    {
      type: 'transcript',
      role: 'assistant',
      text: 'Settings are in front.',
      final: true,
    },
    {
      type: 'action-result',
      name: 'get_weather',
      callId: 'old',
      result: { ok: true },
    },
    { type: 'action-settled', name: 'get_weather', callId: 'old' },
    { type: 'completion', status: 'completed' },
    { type: 'reply-complete', status: 'completed' },
    { type: 'state', state: 'listening' },
    { type: 'interruption', reason: 'user-speech' },
    {
      type: 'transcript',
      role: 'user',
      text: 'What is the weather?',
      final: true,
    },
  ]) {
    f.hooks.emit(event);
    assert.equal(f.foreground(), 'true', event.type);
  }
  f.controls.setVoicePanelOrder('voice-preview', 'front');
  f.hooks.emit({ type: 'completion', status: 'completed' });
  f.hooks.emit({ type: 'interruption' });
  assert.equal(f.foreground(), 'false', 'newer order wins over old completion');
  f.controls.setVoiceSettingsOpen(true);
  assert.equal(f.foreground(), 'true');
  f.hooks.emit({ type: 'interruption' });
  assert.equal(
    f.foreground(),
    'false',
    'ordinary show keeps its yielding behavior',
  );
  f.controls.setVoicePanelOrder('voice-settings', 'front');
  f.controls.setVoiceSettingsOpen(false);
  f.controls.setVoiceSettingsOpen(true);
  f.hooks.emit({ type: 'interruption' });
  assert.equal(f.foreground(), 'false');
  f.controls.setVoicePanelOrder('voice-settings', 'front');
  f.controls.session.stop({ preserveStatus: true });
  assert.equal(f.foreground(), 'false');
  assert.equal(f.ui.voiceSettingsPanel.hidden, true);
  f.controls.setVoiceSettingsOpen(true);
  f.hooks.emit({ type: 'interruption' });
  assert.equal(
    f.foreground(),
    'false',
    'terminal Stop discarded the prior order',
  );
});

test('panel order does not cancel sibling work but ordinary interruption still does', async (t) => {
  const result = deferred();
  let actionSignal;
  const f = panelOrderFixture(t, {
    runner: (_name, _args, options) => {
      actionSignal = options.signal;
      return result.promise;
    },
  });
  await f.controls.session.start();
  const action = f.hooks.runAction('get_weather', {});
  f.controls.setVoicePanelOrder('voice-settings', 'front');
  f.controls.setVoicePanelOrder('voice-preview', 'front');
  f.controls.setVoicePanelOrder('voice-settings', 'front');
  assert.equal(actionSignal.aborted, false);
  f.hooks.emit({ type: 'interruption' });
  assert.equal(actionSignal.aborted, true);
  assert.equal(f.foreground(), 'true');
  result.resolve({ ok: true });
  await assert.rejects(action, { name: 'AbortError' });
  assert.equal(
    f.foreground(),
    'true',
    'late action settlement cannot change order',
  );
});

test('panel-order refusals preserve visibility, preferences and current presentation', async (t) => {
  for (const [label, mutate, panelId, position, reason] of [
    ['unknown panel', () => {}, 'settings', 'front', 'unknown-panel'],
    ['unknown order', () => {}, 'voice-preview', 'top', 'invalid-position'],
    [
      'disabled preview',
      (f) => {
        f.ui.voicePreviewInput.checked = false;
        f.ui.voicePreviewInput.dispatchEvent(new Event('change'));
      },
      'voice-settings',
      'front',
      'preview-disabled',
    ],
    [
      'hidden preview',
      (f) => f.controls.voiceCard.handle({ type: 'idle' }),
      'voice-preview',
      'back',
      'preview-hidden',
    ],
    [
      'closed settings',
      (f) => f.controls.setVoiceSettingsOpen(false),
      'voice-preview',
      'front',
      'settings-closed',
    ],
    [
      'missing preview',
      (f) => {
        f.ui.card = null;
      },
      'voice-settings',
      'front',
      'preview-unavailable',
    ],
    [
      'missing settings',
      (f) => {
        f.ui.voiceSettingsPanel = null;
      },
      'voice-preview',
      'front',
      'settings-unavailable',
    ],
    [
      'body fallback',
      (f) => {
        f.dock.id = 'body';
      },
      'voice-settings',
      'front',
      'unsupported-host',
    ],
    [
      'different parents',
      (f) => {
        f.ui.providerField.parentElement = {};
      },
      'voice-preview',
      'front',
      'unsupported-host',
    ],
    [
      'wrong stacking class',
      (f) => {
        f.ui.providerField.className = '';
      },
      'voice-settings',
      'front',
      'unsupported-host',
    ],
    [
      'CSS-hidden preview',
      (f) => {
        f.ui.card.checkVisibility = () => false;
      },
      'voice-preview',
      'front',
      'preview-hidden',
    ],
  ]) {
    await t.test(label, (t) => {
      const f = panelOrderFixture(t);
      mutate(f);
      const before = f.controls.getVoicePanelOrderState();
      const writes = [...f.writes];
      const focusCalls = f.focusCalls();
      const marker = f.foreground();
      const result = f.controls.setVoicePanelOrder(panelId, position);
      assert.deepEqual(result, {
        ok: false,
        panelId,
        position,
        reason,
        error: result.error,
        ...before,
      });
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length);
      assert.deepEqual(f.controls.getVoicePanelOrderState(), before);
      assert.equal(f.foreground(), marker);
      assert.equal(f.focusCalls(), focusCalls);
      assert.deepEqual(f.writes, writes);
      assert.deepEqual(f.starts, []);
      assert.deepEqual(f.stops, []);
    });
  }
});

test('panel order refuses a dock hidden by Clean View or Recording CSS', async (t) => {
  for (const property of ['checkOpacity', 'checkVisibilityCSS']) {
    await t.test(property, (t) => {
      const f = panelOrderFixture(t);
      f.controls.setVoicePanelOrder('voice-settings', 'front');
      const marker = f.foreground();
      const focusCalls = f.focusCalls();
      // Browser visibility includes ancestors when these checks are requested.
      for (const element of [f.ui.voiceSettingsPanel, f.ui.card])
        element.checkVisibility = (options = {}) => !options[property];
      assert.deepEqual(f.controls.getVoicePanelOrderState(), {
        frontPanelId: null,
        settingsOpen: false,
        previewVisible: false,
        previewEnabled: true,
      });
      const result = f.controls.setVoicePanelOrder('voice-preview', 'front');
      assert.equal(result.ok, false);
      assert.equal(result.frontPanelId, null);
      assert.equal(f.foreground(), marker);
      assert.equal(f.focusCalls(), focusCalls);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.starts, []);
      assert.deepEqual(f.stops, []);
      for (const element of [f.ui.voiceSettingsPanel, f.ui.card])
        element.checkVisibility = () => true;
      assert.equal(
        f.controls.getVoicePanelOrderState().frontPanelId,
        'voice-settings',
      );
    });
  }
});

test('disposed panel-order controls report unavailable state and cannot reapply an old order', (t) => {
  const f = panelOrderFixture(t);
  f.controls.setVoicePanelOrder('voice-settings', 'front');
  f.controls.session.destroy();
  assert.equal(f.foreground(), 'false');
  const result = f.controls.setVoicePanelOrder('voice-settings', 'front');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disposed');
  assert.equal(result.frontPanelId, null);
  assert.equal(result.settingsOpen, false);
  assert.equal(result.previewVisible, false);
  assert.equal(
    result.previewEnabled,
    true,
    'teardown does not change the preview preference',
  );
  f.hooks.emit({ type: 'interruption' });
  assert.equal(f.foreground(), 'false');
});

test('new explicit order or close supersedes a queued Cockpit settings reveal', async (t) => {
  for (const route of ['order', 'open', 'setOpen', 'close-button', 'Escape']) {
    await t.test(route, async (t) => {
      const f = panelOrderFixture(t);
      assert.equal(f.controls.deferVoiceSettingsUntilCockpitExit(), true);
      window.dispatchEvent(
        new CustomEvent('gev:cockpit-mode-changed', {
          detail: { active: false },
        }),
      );
      if (route === 'order') {
        assert.equal(
          f.controls.setVoicePanelOrder('voice-preview', 'front').ok,
          true,
        );
      } else if (route === 'open') {
        f.controls.setVoiceSettingsOpen(true);
      } else if (route === 'setOpen') {
        f.controls.setVoiceSettingsOpen(false);
      } else if (route === 'close-button') {
        f.ui.voiceSettingsClose.dispatchEvent(new Event('click'));
      } else {
        const escape = new Event('keydown', { cancelable: true });
        Object.defineProperty(escape, 'key', { value: 'Escape' });
        f.ui.voiceSettingsPanel.dispatchEvent(escape);
      }
      const focusCalls = f.focusCalls();
      await Promise.resolve();
      assert.equal(
        f.foreground(),
        String(route === 'open'),
        'the older reveal cannot retake foreground',
      );
      assert.equal(
        f.focusCalls(),
        focusCalls,
        'the older reveal cannot refocus settings',
      );
      assert.equal(
        f.ui.voiceSettingsPanel.hidden,
        !['order', 'open'].includes(route),
      );
      f.hooks.emit({ type: 'interruption' });
      assert.equal(f.foreground(), 'false');
    });
  }
});

test('a refused order does not cancel a legitimate deferred reveal', async (t) => {
  const f = panelOrderFixture(t);
  f.controls.setVoiceSettingsOpen(false);
  f.controls.deferVoiceSettingsUntilCockpitExit();
  window.dispatchEvent(
    new CustomEvent('gev:cockpit-mode-changed', {
      detail: { active: false },
    }),
  );
  const result = f.controls.setVoicePanelOrder('voice-settings', 'front');
  assert.equal(result.reason, 'settings-closed');
  await Promise.resolve();
  assert.equal(f.ui.voiceSettingsPanel.hidden, false);
  assert.equal(
    f.foreground(),
    'true',
    'the accepted exit reveal still applies',
  );
  f.hooks.emit({ type: 'interruption' });
  assert.equal(
    f.foreground(),
    'false',
    'deferred show is still ordinary opening intent',
  );
});

test('shared panel empty Preview follows checkbox changes immediately while voice is idle', (t) => {
  const f = panelOrderFixture(t, { sharedPanel: true });
  f.controls.voiceCard.handle({ type: 'idle' });
  f.controls.selectVoicePanelView('preview');
  for (const enabled of [false, true, false]) {
    f.ui.voicePreviewInput.checked = enabled;
    f.ui.voicePreviewInput.dispatchEvent(new Event('change'));
    assert.equal(f.controls.getVoicePreviewEnabled(), enabled);
    assert.equal(f.ui.previewEmpty.hidden, false);
    assert.equal(
      f.ui.previewEmpty.textContent,
      enabled
        ? 'Speak to see captions and results.'
        : 'Voice Preview is off. Enable Voice preview in Settings.',
    );
    assert.equal(f.controls.getVoicePanelOrderState().view, 'preview');
    assert.equal(f.ui.card.hidden, true);
  }
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
});

test('shared panel compatibility close cancels pending Settings without changing Preview', async (t) => {
  for (const previewOpen of [false, true]) {
    for (const exitQueued of [false, true]) {
      await t.test(
        `${previewOpen ? 'open' : 'closed'} Preview, ${exitQueued ? 'queued' : 'pending'} exit`,
        async (t) => {
          const f = panelOrderFixture(t, { sharedPanel: true });
          f.controls.selectVoicePanelView('preview');
          if (!previewOpen) f.controls.closeVoicePanelView('preview');
          const before = f.controls.getVoicePanelOrderState();
          const effects = {
            focus: f.focusCalls(),
            starts: [...f.starts],
            stops: [...f.stops],
            writes: [...f.writes],
          };
          const exit = () =>
            window.dispatchEvent(
              new CustomEvent('gev:cockpit-mode-changed', {
                detail: { active: false },
              }),
            );
          assert.equal(f.controls.deferVoiceSettingsUntilCockpitExit(), true);
          if (exitQueued) exit();
          assert.equal(f.controls.setVoiceSettingsOpen(false), true);
          assert.deepEqual(f.controls.getVoicePanelOrderState(), before);
          if (!exitQueued) exit();
          await Promise.resolve();
          assert.deepEqual(f.controls.getVoicePanelOrderState(), before);
          assert.deepEqual(
            {
              focus: f.focusCalls(),
              starts: f.starts,
              stops: f.stops,
              writes: f.writes,
            },
            effects,
          );
        },
      );
    }
  }
});

test('shared panel inactive-view close leaves a valid deferred Settings reveal intact', async (t) => {
  for (const target of ['preview', 'settings']) {
    await t.test(
      target === 'preview' ? 'already closed Preview' : 'inactive Settings',
      async (t) => {
        const f = panelOrderFixture(t, { sharedPanel: true });
        f.controls.selectVoicePanelView('preview');
        if (target === 'preview') f.controls.closeVoicePanelView('preview');
        const before = f.controls.getVoicePanelOrderState();
        const focusCalls = f.focusCalls();
        assert.equal(f.controls.deferVoiceSettingsUntilCockpitExit(), true);
        const closed = f.controls.closeVoicePanelView(target);
        assert.equal(closed.ok, true);
        assert.equal(closed.changed, false);
        assert.deepEqual(f.controls.getVoicePanelOrderState(), before);
        assert.equal(f.focusCalls(), focusCalls);
        window.dispatchEvent(
          new CustomEvent('gev:cockpit-mode-changed', {
            detail: { active: false },
          }),
        );
        await Promise.resolve();
        assert.equal(f.controls.getVoicePanelOrderState().view, 'settings');
        assert.equal(f.controls.getVoicePanelOrderState().settingsOpen, true);
        assert.deepEqual(f.starts, []);
        assert.deepEqual(f.stops, []);
        assert.deepEqual(f.writes, []);
      },
    );
  }
});

test('public preview preference works with closed settings and idle voice without starting a session', (t) => {
  const f = panelOrderFixture(t);
  f.controls.setVoiceSettingsOpen(false);
  f.hooks.emit({ type: 'state', state: 'idle' });
  const focus = f.doc.activeElement;
  const focusCalls = f.focusCalls();
  assert.deepEqual(f.controls.setVoicePreviewEnabled(false), {
    ok: true,
    enabled: false,
    changed: true,
    persisted: true,
    previewVisible: false,
  });
  assert.equal(f.controls.getVoicePreviewEnabled(), false);
  assert.equal(f.ui.voicePreviewInput.checked, false);
  assert.equal(f.controls.voiceCard.enabled, false);
  assert.equal(f.values.get('godsEyeView.voice.previewEnabled'), 'false');
  f.ui.voicePreviewInput.checked = true;
  f.ui.voicePreviewInput.dispatchEvent(new Event('change'));
  assert.equal(f.controls.getVoicePreviewEnabled(), true);
  assert.equal(f.controls.voiceCard.enabled, true);
  assert.equal(f.values.get('godsEyeView.voice.previewEnabled'), 'true');
  assert.equal(
    f.ui.card.hidden,
    true,
    'enablement does not invent preview content',
  );
  assert.equal(f.ui.voiceSettingsPanel.hidden, true);
  assert.equal(f.doc.activeElement, focus);
  assert.equal(f.focusCalls(), focusCalls);
  assert.equal(f.controls.session.state, 'idle');
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
  assert.equal(f.controls.getVoiceInactivityMinutes(), 5);
});

test('public preview preference preserves current content, expiry and explicit panel order', async (t) => {
  const f = panelOrderFixture(t);
  await f.controls.session.start();
  f.hooks.emit({
    type: 'transcript',
    role: 'assistant',
    text: 'Current reply',
    final: true,
  });
  f.controls.setVoicePanelOrder('voice-settings', 'front');
  const focusCalls = f.focusCalls();
  const deadline = f.controls.voiceCard.hideTimer;
  f.controls.setVoicePreviewEnabled(false);
  assert.equal(f.ui.card.hidden, true);
  assert.equal(f.controls.voiceCard.elements.live.textContent, '');
  assert.equal(f.controls.voiceCard.hideTimer, deadline);
  assert.equal(f.controls.setVoicePreviewEnabled(true).previewVisible, true);
  assert.equal(f.controls.voiceCard.snapshot().assistant.text, 'Current reply');
  assert.equal(f.controls.voiceCard.hideTimer, deadline);
  assert.equal(f.foreground(), 'true');
  assert.equal(f.focusCalls(), focusCalls);
  assert.equal(f.controls.session.state, 'listening');
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.stops, []);
  f.controls.setVoicePreviewEnabled(false);
  f.cardTimers.get(deadline)();
  assert.equal(f.controls.setVoicePreviewEnabled(true).previewVisible, false);
  assert.equal(f.ui.card.hidden, true, 'expired content stays hidden');
  f.hooks.emit({ type: 'interruption' });
  assert.equal(
    f.foreground(),
    'true',
    'preference changes do not clear explicit order',
  );
  f.controls.setVoicePreviewEnabled(false);
  f.controls.voiceCard.handle({ type: 'dismiss' });
  assert.equal(f.controls.setVoicePreviewEnabled(true).previewVisible, false);
  f.controls.setVoicePreviewEnabled(false);
  f.hooks.emit({ type: 'state', state: 'idle' });
  assert.equal(f.controls.setVoicePreviewEnabled(true).previewVisible, false);
  assert.equal(f.controls.voiceCard.snapshot().assistant.text, '');
});

test('invalid and retired public preview requests cannot mutate current preferences', (t) => {
  const f = panelOrderFixture(t);
  const setter = f.controls.setVoicePreviewEnabled;
  assert.equal(setter('false').reason, 'invalid-enabled');
  assert.deepEqual(f.writes, []);
  assert.equal(f.controls.getVoicePreviewEnabled(), true);
  f.controls.voiceCard.destroy();
  assert.equal(setter(false).reason, 'preview-unavailable');
  assert.deepEqual(f.writes, []);
  f.controls.session.destroy();
  assert.equal(f.controls.getVoicePreviewEnabled(), undefined);
  assert.deepEqual(setter(false), {
    ok: false,
    enabled: null,
    changed: false,
    reason: 'disposed',
    error: 'Voice Preview controls are no longer available.',
  });
  assert.deepEqual(f.writes, []);
});

test('public preview preference refuses a missing or detached real card', async (t) => {
  for (const missing of ['ui-card', 'card-element', 'detached-element']) {
    await t.test(missing, (t) => {
      const f = panelOrderFixture(t);
      const card = f.controls.voiceCard;
      if (missing === 'ui-card') f.ui.card = null;
      else if (missing === 'card-element') card.elements.card = null;
      else f.ui.card.isConnected = false;
      const result = f.controls.setVoicePreviewEnabled(false);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'preview-unavailable');
      assert.equal(result.changed, false);
      assert.equal(result.enabled, null);
      assert.equal(f.controls.getVoicePreviewEnabled(), undefined);
      assert.equal(card.enabled, true);
      assert.equal(f.ui.voicePreviewInput.checked, true);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.starts, []);
      assert.deepEqual(f.stops, []);
    });
  }
});
