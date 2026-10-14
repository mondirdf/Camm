import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoicePanelControls,
  voicePanelTranscriptIntent,
} from './voicePanel.js';

function fixture(t, { enabled = true, settings = false, prepare } = {}) {
  const doc = { activeElement: null };
  const node = () => {
    const el = new EventTarget();
    Object.assign(el, {
      hidden: false,
      isConnected: true,
      dataset: {},
      attributes: {},
      ownerDocument: doc,
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      focus() {
        doc.activeElement = this;
      },
      contains(other) {
        return other === this;
      },
      checkVisibility() {
        return !this.hidden;
      },
    });
    return el;
  };
  const ui = Object.fromEntries(
    [
      'voicePanel',
      'previewPanel',
      'voiceSettingsPanel',
      'previewTab',
      'settingsTab',
      'voiceSettingsButton',
      'voiceSettingsClose',
      'previewEmpty',
      'card',
    ].map((k) => [k, node()]),
  );
  ui.voicePanel.contains = (el) =>
    Object.values(ui).includes(el) && el !== ui.voiceSettingsButton;
  let intentCount = 0;
  let content = false;
  const card = {
    presented: true,
    setPresented(value) {
      this.presented = value;
      ui.card.hidden = !(enabled && value && content);
    },
    snapshot() {
      return { visible: enabled && this.presented && content };
    },
  };
  prepare?.(ui, doc);
  const owner = createVoicePanelControls({
    ui,
    card,
    getPreviewEnabled: () => enabled,
    initialSettingsOpen: settings,
    onPresentationIntent: () => intentCount++,
  });
  owner.handle({ type: 'state', state: 'connecting' });
  if (!settings) owner.close();
  t.after(() => owner.destroy());
  const event = (type, extras = {}) => owner.handle({ type, ...extras });
  const final = (text) =>
    event('transcript', { role: 'user', text, final: true });
  const click = (el) => el.dispatchEvent(new Event('click'));
  const keys = (el, key) => {
    const e = new Event('keydown', { cancelable: true });
    Object.defineProperty(e, 'key', { value: key });
    el.dispatchEvent(e);
    return e;
  };
  const assertView = (view) => {
    assert.equal(owner.snapshot().view, view);
    assert.equal(ui.voicePanel.hidden, false);
    assert.equal(ui.previewPanel.hidden, view !== 'preview');
    assert.equal(ui.voiceSettingsPanel.hidden, view !== 'settings');
    assert.equal(
      ui.previewTab.attributes['aria-selected'],
      String(view === 'preview'),
    );
    assert.equal(
      ui.settingsTab.attributes['aria-selected'],
      String(view === 'settings'),
    );
    assert.equal(ui.previewTab.tabIndex, view === 'preview' ? 0 : -1);
    assert.equal(ui.settingsTab.tabIndex, view === 'settings' ? 0 : -1);
  };
  return {
    ui,
    owner,
    card,
    doc,
    event,
    final,
    click,
    keys,
    assertView,
    count: () => intentCount,
    enabled: (value) => {
      enabled = value;
      card.setPresented(card.presented);
      owner.sync();
    },
    content: (value) => {
      content = value;
      card.setPresented(card.presented);
      owner.sync();
    },
  };
}

function layoutFixture(
  t,
  { viewportWidth = 390, left = 200, width = 320, observer = true } = {},
) {
  const priorObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    'ResizeObserver',
  );
  const observations = [];
  class ResizeObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnects = 0;
      observations.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnects++;
    }
    deliver(target) {
      this.callback([{ target }]);
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: observer ? ResizeObserverStub : undefined,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (priorObserver)
      Object.defineProperty(globalThis, 'ResizeObserver', priorObserver);
    else delete globalThis.ResizeObserver;
  });
  const viewWindow = new EventTarget();
  viewWindow.innerWidth = viewportWidth;
  const resizeRegistrations = [];
  let resizeCallbacks = 0;
  viewWindow.addEventListener = (type, callback, options) => {
    const listener =
      type === 'resize'
        ? (event) => {
            resizeCallbacks++;
            callback(event);
          }
        : callback;
    if (type === 'resize') resizeRegistrations.push({ options });
    EventTarget.prototype.addEventListener.call(
      viewWindow,
      type,
      listener,
      options,
    );
  };
  const properties = new Map();
  const writes = [];
  let reads = 0;
  const box = () => {
    // Browser measurements include the transform applied by the previous pass.
    const translatedLeft =
      left + Number.parseFloat(properties.get('--voice-panel-shift-x') || '0');
    return { left: translatedLeft, right: translatedLeft + width, width };
  };
  const f = fixture(t, {
    settings: true,
    prepare(ui, doc) {
      doc.defaultView = viewWindow;
      ui.root = new EventTarget();
      ui.voicePanel.hidden = true;
      ui.voicePanel.style = {
        setProperty(name, value) {
          properties.set(name, value);
          writes.push([name, value]);
        },
      };
      ui.voicePanel.getBoundingClientRect = () => {
        reads++;
        return box();
      };
    },
  });
  return {
    ...f,
    box,
    writes,
    observations,
    resizeRegistrations,
    reads: () => reads,
    resizeCallbacks: () => resizeCallbacks,
    shift: () => properties.get('--voice-panel-shift-x') || '0px',
    setGeometry(next) {
      if (next.left !== undefined) left = next.left;
      if (next.width !== undefined) width = next.width;
    },
    resize(nextWidth = viewWindow.innerWidth) {
      viewWindow.innerWidth = nextWidth;
      viewWindow.dispatchEvent(new Event('resize'));
    },
  };
}

test('opening clamps either overflowing edge while retaining an already fitting anchor', async (t) => {
  for (const [name, left, expectedLeft, expectedRight] of [
    ['left edge', -30, 12, 332],
    ['right edge', 200, 58, 378],
    ['already inside', 35, 35, 355],
  ]) {
    await t.test(name, (t) => {
      const f = layoutFixture(t, { left });
      assert.equal(f.box().left, expectedLeft);
      assert.equal(f.box().right, expectedRight);
      f.assertView('settings');
      assert.equal(f.reads(), 1);
      if (name === 'already inside') assert.deepEqual(f.writes, []);
    });
  }
});

test('repeated resize does not accumulate offsets and widening restores the original anchor', (t) => {
  const f = layoutFixture(t, { left: 220 });
  assert.deepEqual(f.box(), { left: 58, right: 378, width: 320 });
  const writes = [...f.writes];
  f.resize();
  f.resize();
  assert.deepEqual(
    f.writes,
    writes,
    'stable geometry needs no new style writes',
  );
  assert.deepEqual(f.box(), { left: 58, right: 378, width: 320 });
  f.resize(1000);
  assert.equal(f.shift(), '0px');
  assert.deepEqual(f.box(), { left: 220, right: 540, width: 320 });
  f.resize(390);
  assert.deepEqual(f.box(), { left: 58, right: 378, width: 320 });
  f.assertView('settings');
});

test('observed panel width and dock movement reclamp without changing the selected view or focus', (t) => {
  const f = layoutFixture(t, { viewportWidth: 600, left: 260 });
  const [observer] = f.observations;
  assert.deepEqual(observer.targets, [f.ui.voicePanel, f.ui.root]);
  f.ui.settingsTab.focus();
  f.setGeometry({ width: 380 });
  observer.deliver(f.ui.voicePanel);
  assert.deepEqual(f.box(), { left: 208, right: 588, width: 380 });
  f.setGeometry({ left: -40 });
  observer.deliver(f.ui.root);
  assert.deepEqual(f.box(), { left: 12, right: 392, width: 380 });
  f.setGeometry({ left: 140, width: 320 });
  observer.deliver(f.ui.root);
  assert.equal(f.shift(), '0px');
  assert.deepEqual(f.box(), { left: 140, right: 460, width: 320 });
  f.assertView('settings');
  assert.equal(f.doc.activeElement, f.ui.settingsTab);
});

test('closed panels skip geometry work and reopening uses the latest viewport', (t) => {
  const f = layoutFixture(t, { viewportWidth: 1000, left: 220 });
  f.owner.close();
  const reads = f.reads();
  const writes = [...f.writes];
  f.resize(390);
  f.observations[0].deliver(f.ui.root);
  assert.equal(f.reads(), reads);
  assert.deepEqual(f.writes, writes);
  f.owner.select('settings');
  assert.deepEqual(f.box(), { left: 58, right: 378, width: 320 });
  f.assertView('settings');
});

test('destroy disconnects geometry observers and removes the resize listener even when callbacks were queued', (t) => {
  const f = layoutFixture(t);
  const [observer] = f.observations;
  assert.equal(f.resizeRegistrations.length, 1);
  f.resize(1000);
  assert.equal(f.resizeCallbacks(), 1, 'the live listener receives resize');
  const reads = f.reads();
  const writes = [...f.writes];
  f.owner.destroy();
  f.owner.destroy();
  assert.equal(observer.disconnects, 1);
  assert.equal(f.resizeRegistrations[0].options.signal.aborted, true);
  f.setGeometry({ left: -100 });
  f.resize(390);
  observer.deliver(f.ui.voicePanel);
  assert.equal(f.resizeCallbacks(), 1, 'the retired listener was removed');
  assert.equal(f.reads(), reads, 'a queued observer cannot measure retired UI');
  assert.deepEqual(f.writes, writes);
});

test('window resize still clamps and cleans up when ResizeObserver is unavailable', (t) => {
  const f = layoutFixture(t, {
    observer: false,
    viewportWidth: 1000,
    left: 220,
  });
  assert.deepEqual(f.observations, []);
  f.resize(390);
  assert.deepEqual(f.box(), { left: 58, right: 378, width: 320 });
  const callbacks = f.resizeCallbacks();
  const reads = f.reads();
  f.owner.destroy();
  f.resize(1000);
  assert.equal(f.resizeCallbacks(), callbacks);
  assert.equal(f.reads(), reads);
});

test('one panel: provider-adjacent Settings entry, both tabs, keyboard and close', (t) => {
  const f = fixture(t);
  assert.equal(f.ui.voicePanel.hidden, true);
  f.click(f.ui.voiceSettingsButton);
  f.assertView('settings');
  assert.equal(f.doc.activeElement, f.ui.settingsTab);
  f.click(f.ui.voiceSettingsButton);
  f.assertView('settings');
  f.keys(f.ui.settingsTab, 'ArrowLeft');
  f.assertView('preview');
  assert.equal(f.doc.activeElement, f.ui.previewTab);
  f.keys(f.ui.previewTab, 'End');
  f.assertView('settings');
  assert.equal(f.keys(f.ui.voicePanel, 'Escape').defaultPrevented, true);
  assert.equal(f.ui.voicePanel.hidden, true);
  assert.equal(f.doc.activeElement, f.ui.voiceSettingsButton);
});

test('activation defaults to Preview but cannot replace selected Settings or enable disabled Preview', (t) => {
  const f = fixture(t);
  f.event('state', { state: 'connecting' });
  f.assertView('preview');
  f.click(f.ui.settingsTab);
  for (const state of [
    'connecting',
    'listening',
    'speaking',
    'idle',
    'error',
  ]) {
    f.event('state', { state });
    f.assertView('settings');
  }
  f.enabled(false);
  f.owner.close();
  f.event('state', { state: 'connecting' });
  assert.equal(f.ui.voicePanel.hidden, true);
});

test('microphone and partial input preserve Settings; a normal committed request selects Preview', (t) => {
  const f = fixture(t, { settings: true });
  f.ui.voiceSettingsPanel.focus();
  f.event('interruption', { reason: 'user-speech' });
  f.event('transcript', { role: 'user', text: 'show', final: false });
  f.event('transcript', { role: 'assistant', text: 'Working', final: true });
  f.event('progress', { name: 'fly_to_location' });
  f.assertView('settings');
  assert.equal(f.doc.activeElement, f.ui.voiceSettingsPanel);
  f.final('Where am I?');
  f.assertView('preview');
});

test('the first final input can arrive after response completion and still selects Preview', (t) => {
  const f = fixture(t, { settings: true });
  f.event('interruption', { reason: 'user-speech' });
  f.event('transcript', { role: 'assistant', text: '4', final: true });
  f.event('completion', { status: 'completed' });
  f.final('What is 2 plus 2?');
  f.assertView('preview');
});

test('manual selection, close and Stop still beat a first final after completion', (t) => {
  const f = fixture(t, { settings: true });
  f.event('interruption');
  f.event('completion', { status: 'completed' });
  f.click(f.ui.settingsTab);
  f.final('Where is Tokyo?');
  f.assertView('settings');

  f.event('interruption');
  f.event('completion', { status: 'completed' });
  f.owner.close();
  f.final('Where is London?');
  assert.equal(f.ui.voicePanel.hidden, true);

  f.event('interruption');
  f.event('completion', { status: 'completed' });
  f.event('state', { state: 'idle' });
  f.final('Where is Paris?');
  assert.equal(f.ui.voicePanel.hidden, true);
});

test('a contradictory replay after the accepted late final cannot steal the selected view', (t) => {
  const f = fixture(t, { settings: true });
  f.event('interruption');
  f.event('completion', { status: 'completed' });
  f.final('Where is Tokyo?');
  f.assertView('preview');
  f.final('Disable voice preview');
  f.assertView('preview');
});

test('Gemini input deltas arm consecutive turns after completion', (t) => {
  const f = fixture(t, { settings: true });
  f.event('completion', { status: 'completed' });
  f.event('transcript', { role: 'user', text: 'Where', final: false });
  f.final('Where is Tokyo?');
  f.assertView('preview');

  f.event('completion', { status: 'completed' });
  f.event('transcript', { role: 'user', text: 'Disable', final: false });
  f.final('Disable voice preview');
  f.assertView('settings');
});

test('a late normal final cannot expose disabled Preview', (t) => {
  const f = fixture(t, { enabled: false, settings: true });
  f.event('interruption');
  f.event('completion', { status: 'completed' });
  f.final('Where is Tokyo?');
  f.assertView('settings');
  assert.equal(f.owner.snapshot().previewVisible, false);
});

test('Settings tool intent survives delayed Gemini final and all late output', (t) => {
  const f = fixture(t);
  f.event('state', { state: 'connecting' });
  f.event('interruption');
  f.event('action-call', {
    name: 'set_voice_inactivity_timeout',
    arguments: { minutes: 7 },
  });
  f.assertView('settings');
  f.event('completion', { status: 'completed' });
  f.final('make that seven minutes');
  f.event('action-result', {
    name: 'set_voice_inactivity_timeout',
    result: { ok: true },
  });
  f.event('transcript', {
    role: 'assistant',
    text: 'Seven minutes',
    final: true,
  });
  f.assertView('settings');
  f.event('interruption');
  f.final('Show flights over London');
  f.assertView('preview');
});

test('newer manual selection and close beat a current turn final/action; a fresh turn can switch', (t) => {
  const f = fixture(t);
  f.event('interruption');
  f.event('transcript', { role: 'user', text: 'Show', final: false });
  f.click(f.ui.settingsTab);
  f.final('Show flights');
  f.event('action-call', { name: 'get_context', arguments: {} });
  f.assertView('settings');
  f.owner.close();
  f.event('action-result', { name: 'get_context', result: { ok: true } });
  f.event('transcript', {
    role: 'assistant',
    text: 'Flights shown',
    final: true,
  });
  assert.equal(f.ui.voicePanel.hidden, true);
  f.event('interruption');
  f.final('Where is Tokyo?');
  f.assertView('preview');
});

test('explicit preview selection while disabled explains the preference without exposing content', (t) => {
  const f = fixture(t, { enabled: false, settings: true });
  f.content(true);
  f.event('interruption');
  f.final('Where am I?');
  f.assertView('settings');
  f.click(f.ui.previewTab);
  f.assertView('preview');
  assert.equal(f.owner.snapshot().previewEnabled, false);
  assert.equal(f.owner.snapshot().previewVisible, false);
  assert.equal(f.ui.card.hidden, true);
  assert.match(f.ui.previewEmpty.textContent, /off/);
  f.enabled(true);
  assert.equal(f.owner.snapshot().previewVisible, true);
});

test('card expiry and preference updates never change Settings or close the shared panel', (t) => {
  const f = fixture(t, { settings: true });
  f.content(true);
  f.content(false);
  f.enabled(false);
  f.assertView('settings');
  assert.equal(f.card.presented, false);
  f.enabled(true);
  f.assertView('settings');
});

test('generic settings clarification and ambiguous yes do not open a guessed view', (t) => {
  const f = fixture(t);
  f.event('interruption');
  f.final('Can you show settings?');
  f.event('action-call', {
    name: 'set_panel_open',
    arguments: { panelId: 'settings', open: true },
  });
  assert.equal(f.ui.voicePanel.hidden, true);
  f.final('yes');
  assert.equal(f.ui.voicePanel.hidden, true);
  f.owner.select('settings');
  f.final('yes, provider settings');
  f.assertView('settings');
});

test('closing only an inactive view is a no-op and cannot open another one', (t) => {
  const f = fixture(t, { settings: true });
  const intents = f.count();
  f.event('interruption');
  assert.equal(f.owner.close('preview').changed, false);
  assert.equal(f.count(), intents, 'inactive close does not cancel a reveal');
  f.assertView('settings');
  f.final('Where is Tokyo?');
  f.assertView('preview');
  f.owner.select('settings');
  assert.equal(f.owner.close('settings').changed, true);
  assert.equal(f.ui.voicePanel.hidden, true);
  const closedIntents = f.count();
  assert.equal(f.owner.close('settings').changed, false);
  assert.equal(
    f.count(),
    closedIntents + 1,
    'matching close still cancels a pending reveal when already hidden',
  );
});

test('closing an already closed Preview does not cancel a pending Settings intent', (t) => {
  const f = fixture(t);
  assert.equal(f.owner.snapshot().view, 'preview');
  assert.equal(f.owner.snapshot().panelOpen, false);
  const intents = f.count();
  assert.equal(f.owner.close('preview').changed, false);
  assert.equal(f.count(), intents);
  assert.equal(f.owner.snapshot().panelOpen, false);
});

test('final close, hide and dismiss input cannot preselect the inactive view before its action', async (t) => {
  for (const verb of ['Close', 'Hide', 'Dismiss']) {
    for (const selected of ['preview', 'settings']) {
      await t.test(`${verb}: ${selected} remains selected`, (t) => {
        const f = fixture(t, { settings: selected === 'settings' });
        if (selected === 'preview') f.owner.select('preview');
        const target = selected === 'preview' ? 'settings' : 'preview';
        f.event('interruption');
        const intents = f.count();
        const text = `${verb} Voice ${target}`;
        assert.equal(voicePanelTranscriptIntent(text), null);
        f.final(text);
        f.assertView(selected);
        f.event('action-call', {
          name: 'set_panel_open',
          arguments: { panelId: `voice-${target}`, open: false },
        });
        assert.equal(f.owner.close(target).changed, false);
        f.assertView(selected);
        assert.equal(f.count(), intents);
      });
    }
  }
});

test('explicit view input leaves closed or selected presentation untouched until the guarded action runs', async (t) => {
  for (const settings of [false, true]) {
    await t.test(settings ? 'Settings selected' : 'panel closed', (t) => {
      const f = fixture(t, { settings });
      const before = f.owner.snapshot();
      const intents = f.count();
      for (const verb of [
        'Show',
        'Open',
        'Select',
        'Switch to',
        'Bring',
        'Close',
        'Hide',
        'Dismiss',
      ]) {
        for (const view of ['Preview', 'Settings', 'Preferences']) {
          const text = `${verb} Voice ${view}`;
          assert.equal(voicePanelTranscriptIntent(text), null, text);
          f.event('interruption');
          f.final(text);
          assert.deepEqual(f.owner.snapshot(), before, text);
        }
      }
      assert.equal(f.count(), intents);
    });
  }
});

test('polite ambiguous replies do not guess a view or reveal a closed panel', (t) => {
  const f = fixture(t, { settings: true });
  for (const open of [true, false]) {
    if (!open) f.owner.close();
    const before = f.owner.snapshot();
    for (const text of ['yes please', 'no thanks', 'okay thanks']) {
      assert.equal(voicePanelTranscriptIntent(text), null);
      f.event('interruption');
      f.final(text);
      assert.deepEqual(f.owner.snapshot(), before, text);
    }
  }
});

test('one error alert moves across tabs and returns to the root on close or disposal with its listener intact', (t) => {
  const moves = [];
  let dismissals = 0;
  const f = fixture(t, {
    prepare(ui) {
      ui.root = new EventTarget();
      for (const parent of [ui.root, ui.previewPanel, ui.voiceSettingsPanel]) {
        parent.children = [{ sentinel: true }];
        const adopt = (child, prepend) => {
          const old = child.parentNode?.children;
          if (old) old.splice(old.indexOf(child), 1);
          child.parentNode = parent;
          if (prepend) parent.children.unshift(child);
          else parent.children.push(child);
          moves.push({ parent, child });
        };
        parent.prepend = (child) => adopt(child, true);
        parent.append = (child) => adopt(child, false);
      }
      ui.errorTray = new EventTarget();
      ui.errorTray.role = 'alert';
      ui.errorTray.addEventListener('dismiss', () => dismissals++);
      ui.root.append(ui.errorTray);
    },
  });
  const alert = f.ui.errorTray;
  const assertAlert = (parent, index) => {
    assert.equal(f.ui.errorTray, alert);
    assert.equal(alert.parentNode, parent);
    assert.equal(parent.children.at(index), alert);
    assert.equal(alert.role, 'alert');
    assert.equal(
      [f.ui.root, f.ui.previewPanel, f.ui.voiceSettingsPanel]
        .flatMap((node) => node.children)
        .filter((child) => child === alert).length,
      1,
      'the original alert occurs in exactly one parent',
    );
    const before = dismissals;
    alert.dispatchEvent(new Event('dismiss'));
    assert.equal(dismissals, before + 1);
  };
  assertAlert(f.ui.root, -1);
  f.owner.select('settings');
  assertAlert(f.ui.voiceSettingsPanel, 0);
  const afterSettings = moves.length;
  f.owner.sync();
  f.owner.select('settings');
  assert.equal(moves.length, afterSettings, 'same-parent sync never reparents');
  f.owner.select('preview');
  assertAlert(f.ui.previewPanel, 0);
  f.enabled(false);
  assertAlert(f.ui.previewPanel, 0);
  f.owner.close();
  assertAlert(f.ui.root, -1);
  f.owner.select('settings');
  assertAlert(f.ui.voiceSettingsPanel, 0);
  f.owner.destroy();
  assertAlert(f.ui.root, -1);
  const afterDestroy = moves.length;
  f.owner.destroy();
  f.owner.sync();
  assert.equal(moves.length, afterDestroy);
});

test('retired owner ignores late events and stored handlers', (t) => {
  const f = fixture(t);
  f.owner.destroy();
  f.event('interruption');
  f.final('Show Tokyo');
  f.click(f.ui.settingsTab);
  assert.equal(f.ui.voicePanel.hidden, true);
  assert.equal(f.owner.select('settings').reason, 'disposed');
  assert.equal(f.owner.close().reason, 'disposed');
});

test('late input after Stop or completed-turn replay cannot reopen or steal a view', (t) => {
  const f = fixture(t, { settings: true });
  f.event('interruption');
  f.final('Where is Tokyo?');
  f.event('completion', { status: 'completed' });
  f.click(f.ui.settingsTab);
  f.final('Where is Tokyo?');
  f.event('action-call', { name: 'get_context', arguments: {} });
  f.assertView('settings');
  f.event('state', { state: 'idle' });
  f.owner.close();
  f.event('state', { state: 'listening' });
  f.event('interruption');
  f.final('Show flights');
  f.event('action-call', { name: 'get_context', arguments: {} });
  assert.equal(f.ui.voicePanel.hidden, true);
  assert.equal(voicePanelTranscriptIntent('Open Provider Settings'), null);
});

test('final input distinguishes requested view, preference edits and normal conversation', () => {
  for (const text of ['Show voice preview', 'Open preview'])
    assert.equal(voicePanelTranscriptIntent(text), null);
  for (const text of [
    'Disable voice preview',
    'Switch to Gemini',
    'Set inactivity to seven minutes',
  ])
    assert.equal(voicePanelTranscriptIntent(text), 'settings');
  for (const text of ['', 'yes', 'show settings', 'Show voice settings'])
    assert.equal(voicePanelTranscriptIntent(text), null);
  assert.equal(voicePanelTranscriptIntent('Tell me about Tokyo'), 'preview');
});
