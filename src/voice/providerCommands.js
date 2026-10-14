import { supportedVoiceProviders } from './providerCapabilities.js';

const STORAGE_KEY = 'gev.voice.provider';

export function readVoiceProvider(storage, supported = ['openai', 'gemini']) {
  let saved;
  try {
    saved = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY);
  } catch {
    /* Storage is optional. */
  }
  return supported.includes(saved)
    ? saved
    : supported.includes('openai')
      ? 'openai'
      : supported[0];
}

/** Keep one public controller identity while replacing each provider's lifetime. */
export function createProviderCommands(options, { bind, factories, storage }) {
  const supportedProviders = supportedVoiceProviders(
    options.supportedProviders ?? Object.keys(factories),
    factories,
  );
  window.__gevVoiceCommands?.stop?.({ removeUi: true });
  let provider = readVoiceProvider(storage, supportedProviders);
  let current;
  let disposed = false;
  const lifetime = new AbortController();
  let mountGeneration = 0;
  let voiceEnabled = false;
  const stored = () => {
    try {
      return storage ?? globalThis.localStorage;
    } catch {
      return null;
    }
  };
  const stop = (settings = {}) => {
    if (disposed) return;
    voiceEnabled = false;
    if (settings.removeUi) {
      disposed = true;
      options.signal?.removeEventListener('abort', destroy);
    }
    try {
      current?.cancelDeferredVoiceSettings?.();
      current?.session.stop(settings);
    } finally {
      if (settings.removeUi) {
        lifetime.abort();
        options.runner.dispose?.();
      }
    }
  };
  const destroy = () => stop({ removeUi: true });
  const selectProvider = (next) => {
    if (disposed || !supportedProviders.includes(next) || next === provider)
      return false;
    const panelState = current?.getVoicePanelOrderState?.();
    const voicePreviewEnabled = current?.getVoicePreviewEnabled?.();
    const voiceInactivityMinutes = current?.getVoiceInactivityMinutes?.();
    const resume = voiceEnabled && current.session.isActive();
    // Carry the input mode, never a held key, microphone or conversation.
    const pushToTalk = Boolean(
      current.session.adapter.getStartOptions?.().pushToTalk,
    );
    current.session.destroy();
    provider = next;
    try {
      stored()?.setItem(STORAGE_KEY, provider);
    } catch {
      /* Storage is optional. */
    }
    mount({
      voiceSettingsOpen: panelState?.settingsOpen === true,
      voicePreviewEnabled,
      voiceInactivityMinutes,
    });
    if (resume && !disposed) void current.session.start({ pushToTalk });
    globalThis.document?.getElementById('gev-voice-provider')?.focus();
    return true;
  };

  const handleSessionEvent = (event) => {
    if (event?.type === 'state' && event.state === 'connecting')
      voiceEnabled = true;
    if (
      event?.type === 'stop' ||
      (event?.type === 'state' && ['idle', 'error'].includes(event.state))
    ) {
      voiceEnabled = false;
    }
  };

  const sendTextCommand = (text) => {
    if (disposed) return false;
    return current.session.sendText(text);
  };

  const unavailablePanelView = () => ({
    ok: false,
    changed: false,
    reason: disposed ? 'disposed' : 'unavailable',
    error: disposed
      ? 'Voice controls are no longer available.'
      : 'Voice panel views are not available.',
    view: null,
    panelOpen: false,
    settingsOpen: false,
    previewVisible: false,
    previewEnabled: false,
    frontPanelId: null,
    ...(!disposed ? current?.getVoicePanelOrderState?.() : {}),
  });

  const api = {
    // The shared action surface is independent of an active voice connection.
    runner: options.runner,
    supportedProviders,
    signal: lifetime.signal,
    get provider() {
      return provider;
    },
    get session() {
      return current?.session;
    },
    get status() {
      return current?.status ?? current?.session.state ?? 'idle';
    },
    get state() {
      return current?.session.state ?? 'idle';
    },
    get disposed() {
      return disposed;
    },
    start: (settings) => !disposed && current.session.start(settings),
    stop,
    destroy,
    isActive: () => !disposed && current.session.isActive(),
    sendTextCommand,
    sendText: sendTextCommand,
    notifyMapEvent: (event) => !disposed && current.session.sendMapEvent(event),
    setVoiceSettingsOpen: (open) =>
      !disposed && current?.setVoiceSettingsOpen?.(open),
    selectVoicePanelView: (view) =>
      !disposed && typeof current?.selectVoicePanelView === 'function'
        ? current.selectVoicePanelView(view)
        : unavailablePanelView(),
    closeVoicePanelView: (view) =>
      !disposed && typeof current?.closeVoicePanelView === 'function'
        ? current.closeVoicePanelView(view)
        : unavailablePanelView(),
    deferVoiceSettingsUntilCockpitExit: () =>
      !disposed && current?.deferVoiceSettingsUntilCockpitExit?.(),
    cancelDeferredVoiceSettings: () =>
      !disposed && current?.cancelDeferredVoiceSettings?.(),
    getVoicePanelOrderState: () =>
      !disposed ? current?.getVoicePanelOrderState?.() : unavailablePanelView(),
    getVoicePreviewEnabled: () =>
      !disposed ? current?.getVoicePreviewEnabled?.() : undefined,
    setVoicePreviewEnabled: (enabled) => {
      if (!disposed && current?.setVoicePreviewEnabled)
        return current.setVoicePreviewEnabled(enabled);
      return {
        ok: false,
        enabled: !disposed
          ? (current?.getVoicePreviewEnabled?.() ?? null)
          : null,
        changed: false,
        reason: disposed ? 'disposed' : 'preview-unavailable',
        error: disposed
          ? 'Voice Preview controls are no longer available.'
          : 'Voice Preview is not available.',
      };
    },
    setVoicePanelOrder: (panelId, position) => {
      if (!disposed && current?.setVoicePanelOrder)
        return current.setVoicePanelOrder(panelId, position);
      return {
        ok: false,
        panelId,
        position,
        reason: disposed ? 'disposed' : 'unavailable',
        error: disposed
          ? 'Voice controls are no longer available.'
          : 'Voice panel ordering is not available.',
        frontPanelId: null,
        settingsOpen: false,
        previewVisible: false,
        previewEnabled: false,
        ...current?.getVoicePanelOrderState?.(),
      };
    },
    setVoiceInactivityMinutes: (minutes) =>
      !disposed && current?.setVoiceInactivityMinutes?.(minutes),
    getVoiceInactivityMinutes: () =>
      !disposed ? current?.getVoiceInactivityMinutes?.() : undefined,
  };
  // Existing diagnostic and controller accessors continue to reflect the active provider.
  const facade = new Proxy(api, {
    get(target, name, receiver) {
      if (Reflect.has(target, name)) return Reflect.get(target, name, receiver);
      const value = current?.[name];
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  function mount({
    voiceSettingsOpen = false,
    voicePreviewEnabled,
    voiceInactivityMinutes,
  } = {}) {
    voiceEnabled = false;
    const generation = ++mountGeneration;
    current = bind({
      ...options,
      signal: lifetime.signal,
      resetExisting: false,
      disposeRunner: false,
      provider,
      supportedProviders,
      onProviderChange: selectProvider,
      onSessionEvent: (event) => {
        if (!disposed && generation === mountGeneration)
          handleSessionEvent(event);
      },
      storage: stored(),
      voiceSettingsOpen,
      voicePreviewEnabled,
      voiceInactivityMinutes,
      createSession: factories[provider],
    });
    window.__gevVoiceCommands = facade;
  }
  mount();
  options.signal?.addEventListener('abort', destroy, { once: true });
  if (options.signal?.aborted) destroy();
  return facade;
}
