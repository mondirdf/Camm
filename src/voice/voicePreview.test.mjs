import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PREVIEW_STORAGE_KEY,
  bindVoicePreviewSettings,
} from './voicePreview.js';

function fixture(t, storage, card, { initialEnabled, root } = {}) {
  const input = new EventTarget();
  input.checked = false;
  const enabled = [];
  let changeHandler;
  const addEventListener = input.addEventListener.bind(input);
  input.addEventListener = (type, handler) => {
    if (type === 'change') changeHandler = handler;
    addEventListener(type, handler);
  };
  const unsubscribe = bindVoicePreviewSettings({
    ui: { voicePreviewInput: input, root },
    card: card ?? { setEnabled: (value) => enabled.push(value) },
    storage,
    initialEnabled,
  });
  t.after(unsubscribe);
  const change = (value) => {
    input.checked = value;
    input.dispatchEvent(new Event('change'));
  };
  return {
    input,
    enabled,
    change,
    unsubscribe,
    retainedChange: () => changeHandler(),
  };
}

test('Voice preview defaults on unless the stored preference is exactly false', (t) => {
  assert.equal(VOICE_PREVIEW_STORAGE_KEY, 'godsEyeView.voice.previewEnabled');
  for (const raw of [
    null,
    undefined,
    '',
    'true',
    'FALSE',
    ' false ',
    '0',
    false,
    'false',
  ]) {
    const reads = [];
    const writes = [];
    const f = fixture(t, {
      getItem: (key) => {
        reads.push(key);
        return raw;
      },
      setItem: (...args) => writes.push(args),
    });
    assert.equal(
      f.input.checked,
      raw !== 'false',
      `stored value ${String(raw)}`,
    );
    assert.deepEqual(f.enabled, [raw !== 'false']);
    assert.deepEqual(reads, [VOICE_PREVIEW_STORAGE_KEY]);
    assert.deepEqual(
      writes,
      [],
      'initialization does not overwrite a preference',
    );
  }
});

test('changing preview persists across remounts and cleanup removes the old handler', (t) => {
  const values = new Map();
  const writes = [];
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      values.set(key, value);
      writes.push([key, value]);
    },
  };
  const first = fixture(t, storage);
  first.change(false);
  assert.deepEqual(first.enabled, [true, false]);
  assert.equal(values.get(VOICE_PREVIEW_STORAGE_KEY), 'false');
  first.unsubscribe();
  first.unsubscribe();
  first.change(true);
  assert.deepEqual(
    first.enabled,
    [true, false],
    'retired checkbox no longer updates the card',
  );
  assert.equal(writes.length, 1);
  const next = fixture(t, storage);
  assert.equal(next.input.checked, false);
  assert.deepEqual(next.enabled, [false]);
  next.change(true);
  assert.equal(values.get(VOICE_PREVIEW_STORAGE_KEY), 'true');
  assert.deepEqual(next.enabled, [false, true]);
});

test('a failed preview preference read leaves a working default-on checkbox', (t) => {
  const writes = [];
  const f = fixture(t, {
    getItem() {
      throw new Error('storage read denied');
    },
    setItem: (...args) => writes.push(args),
  });
  assert.equal(f.input.checked, true);
  f.change(false);
  assert.deepEqual(f.enabled, [true, false]);
  assert.deepEqual(writes, [[VOICE_PREVIEW_STORAGE_KEY, 'false']]);
});

test('a failed preview preference write cannot prevent the current toggle', (t) => {
  const f = fixture(t, {
    getItem: () => 'false',
    setItem() {
      throw new Error('storage quota exceeded');
    },
  });
  assert.doesNotThrow(() => f.change(true));
  assert.equal(f.input.checked, true);
  assert.deepEqual(f.enabled, [false, true]);
  assert.doesNotThrow(() => f.change(false));
  assert.deepEqual(f.enabled, [false, true, false]);
});

test('a throwing localStorage getter does not prevent preview changes', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage unavailable');
    },
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  const f = fixture(t);
  assert.equal(f.input.checked, true);
  assert.doesNotThrow(() => f.change(false));
  assert.deepEqual(f.enabled, [true, false]);
  assert.deepEqual(f.unsubscribe.setEnabled(true), {
    ok: true,
    enabled: true,
    changed: true,
    persisted: false,
  });
});

test('preview binding tolerates cards without setEnabled and controls without a checkbox', (t) => {
  const f = fixture(t, null, {});
  assert.equal(f.input.checked, true);
  assert.doesNotThrow(() => f.change(false));
  const unbind = bindVoicePreviewSettings({ ui: {}, card: {}, storage: null });
  assert.equal(typeof unbind, 'function');
  assert.doesNotThrow(unbind);
});

test('absolute preview requests and checkbox changes share one state and verified persistence', (t) => {
  const values = new Map();
  const f = fixture(t, {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  assert.equal(f.unsubscribe.getEnabled(), true);
  assert.deepEqual(f.unsubscribe.setEnabled(false), {
    ok: true,
    enabled: false,
    changed: true,
    persisted: true,
  });
  assert.equal(f.input.checked, false);
  assert.equal(f.unsubscribe.getEnabled(), false);
  assert.equal(values.get(VOICE_PREVIEW_STORAGE_KEY), 'false');
  assert.deepEqual(f.unsubscribe.setEnabled(false), {
    ok: true,
    enabled: false,
    changed: false,
    persisted: true,
  });
  f.change(true);
  assert.equal(f.unsubscribe.getEnabled(), true);
  assert.equal(values.get(VOICE_PREVIEW_STORAGE_KEY), 'true');
  assert.deepEqual(f.enabled, [true, false, false, true]);
});

test('preview requests reject non-booleans without changing presentation or persistence', (t) => {
  const writes = [];
  const f = fixture(t, {
    getItem: () => null,
    setItem: (...args) => writes.push(args),
  });
  for (const value of [undefined, null, 'false', 'true', 0, 1, {}, []]) {
    const result = f.unsubscribe.setEnabled(value);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-enabled');
    assert.equal(result.enabled, true);
    assert.equal(result.changed, false);
    assert.equal(f.input.checked, true);
    assert.equal(f.unsubscribe.getEnabled(), true);
  }
  assert.deepEqual(f.enabled, [true]);
  assert.deepEqual(writes, []);
});

test('preview applies locally but reports false persistence for unavailable or unverified storage', (t) => {
  for (const storage of [
    null,
    {},
    { getItem: () => 'true', setItem() {} },
    { getItem: () => false, setItem() {} },
    {
      getItem: () => 'true',
      setItem() {
        throw new Error('blocked');
      },
    },
    {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {},
    },
  ]) {
    const f = fixture(t, storage);
    assert.deepEqual(f.unsubscribe.setEnabled(false), {
      ok: true,
      enabled: false,
      changed: true,
      persisted: false,
    });
    assert.equal(f.input.checked, false);
    assert.equal(f.unsubscribe.getEnabled(), false);
    assert.equal(f.enabled.at(-1), false);
  }
});

test('a repeated absolute request can persist a live choice after storage recovers', (t) => {
  let blocked = true;
  let saved = null;
  const f = fixture(t, {
    getItem: () => saved,
    setItem(_key, value) {
      if (blocked) throw new Error('blocked');
      saved = value;
    },
  });
  assert.equal(f.unsubscribe.setEnabled(false).persisted, false);
  blocked = false;
  assert.deepEqual(f.unsubscribe.setEnabled(false), {
    ok: true,
    enabled: false,
    changed: false,
    persisted: true,
  });
  assert.equal(saved, 'false');
});

test('a provider remount override restores only the live preference without a storage write', (t) => {
  let reads = 0;
  let writes = 0;
  const f = fixture(
    t,
    {
      getItem() {
        reads++;
        return 'true';
      },
      setItem() {
        writes++;
      },
    },
    undefined,
    { initialEnabled: false },
  );
  assert.equal(f.unsubscribe.getEnabled(), false);
  assert.equal(f.input.checked, false);
  assert.deepEqual(f.enabled, [false]);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('disposed or unavailable preview controls refuse retained setters and callbacks', (t) => {
  const writes = [];
  const f = fixture(t, {
    getItem: () => null,
    setItem: (...args) => writes.push(args),
  });
  const setter = f.unsubscribe.setEnabled;
  f.unsubscribe();
  assert.equal(f.unsubscribe.getEnabled(), undefined);
  assert.deepEqual(setter(false), {
    ok: false,
    enabled: null,
    changed: false,
    reason: 'disposed',
    error: 'Voice Preview controls are no longer available.',
  });
  f.input.checked = false;
  f.retainedChange();
  assert.deepEqual(f.enabled, [true]);
  assert.deepEqual(writes, []);
  const missing = fixture(t, null, {});
  assert.equal(
    missing.unsubscribe.setEnabled(false).reason,
    'preview-unavailable',
  );
  assert.equal(missing.unsubscribe.getEnabled(), undefined);
  const root = { isConnected: true };
  const removed = fixture(t, null, undefined, { root });
  root.isConnected = false;
  assert.equal(
    removed.unsubscribe.setEnabled(false).reason,
    'preview-unavailable',
  );
  assert.deepEqual(removed.enabled, [true]);
});
