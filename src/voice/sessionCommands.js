import { createVoiceControl } from './control.js';
import { createVoiceSession } from './session.js';
import {
  bindVoiceInactivitySettings,
  createDeferredVoiceSettingsIntent,
  createVoiceInactivityController,
} from './inactivity.js';

const DEFAULT_ERROR_HINT =
  'Check microphone permission and network access, then try again.';
import { VoiceCardControls } from './voiceCard.js';
import { bindVoicePreviewSettings } from './voicePreview.js';
import { createVoicePanelControls } from './voicePanel.js';
import { PointerReticle } from './pointerReticle.js';

function createDefaultReticle(pointer) {
  const element = pointer?.element;
  const doc = element?.ownerDocument;
  if (!doc) return null;
  return new PointerReticle({
    doc,
    rectOf: () => element.getBoundingClientRect?.() || null,
  });
}

/** Bind common controls to a supplied voice-session adapter. */
export function createVoiceCommands({
  runner,
  dataManager,
  annotations = null,
  createSession,
  createController,
  backend,
  signal,
  debugSink,
  createControl = createVoiceControl,
  resetExisting = true,
  provider,
  supportedProviders,
  onProviderChange,
  onSessionEvent,
  storage,
  showToast,
  voiceSettingsOpen = false,
  voicePreviewEnabled,
  voiceInactivityMinutes,
  createCard = (options) => new VoiceCardControls(options),
  pointer = null,
  referents = null,
  createReticle = createDefaultReticle,
  disposeRunner = true,
}) {
  if (resetExisting) window.__gevVoiceCommands?.stop?.({ removeUi: true });
  const ui = createControl({ reset: true });
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter: (hooks) =>
      createSession({
        ...hooks,
        runner,
        ui,
        dataManager,
        backend,
        debugSink,
        createController,
        pointer,
        radioLayer: dataManager?.layers?.get('radio')?.module || null,
      }),
  });
  const adapter = session.adapter;
  const capabilities = adapter.capabilities || {};
  let settingsUnsubscribe;
  let deferredSettings;
  let panel;
  const setSettingsOpen = (open) => {
    // The compatibility setter also cancels a queued Settings reveal, even
    // when the shared panel currently retains the other view.
    if (!open) deferredSettings?.cancel();
    return panel
      ? (open ? panel.select('settings') : panel.close('settings')).ok
      : (settingsUnsubscribe.setOpen?.(open) ?? false);
  };
  const inactivity = createVoiceInactivityController({
    session,
    onExpire: () => panel?.close() ?? settingsUnsubscribe?.setOpen?.(false),
  });
  const inactivityUnsubscribe = session.subscribe((event) =>
    inactivity.handleEvent(event),
  );
  settingsUnsubscribe = bindVoiceInactivitySettings({
    ui,
    storage,
    controller: inactivity,
    initialOpen: voiceSettingsOpen,
    initialMinutes: voiceInactivityMinutes,
    manageDisclosure: !ui.voicePanel,
    onPresentationIntent: () => deferredSettings?.cancel(),
  });
  deferredSettings = createDeferredVoiceSettingsIntent({
    open: () => setSettingsOpen(true),
    onExpire: () =>
      showToast?.(
        'Voice Settings request expired — exit Cockpit and ask again.',
      ),
  });
  if (ui.providerLimitNote) {
    ui.providerLimitNote.textContent = capabilities.advisoryLimit || '';
    ui.providerLimitNote.hidden = true;
  }
  const providerHandler = () => onProviderChange?.(ui.providerSelect.value);
  // Embedders may supply one adapter without a provider selector. The shared
  // settings (including OpenAI cost controls) still belong to that adapter.
  if (ui.providerField) ui.providerField.hidden = false;
  if (ui.providerSelect) ui.providerSelect.hidden = !onProviderChange;
  if (ui.providerSelect && onProviderChange) {
    if (supportedProviders && ui.providerSelect.replaceChildren) {
      const doc = ui.providerSelect.ownerDocument;
      ui.providerSelect.replaceChildren(
        ...supportedProviders.map((name) => {
          const option = doc.createElement('option');
          option.value = name;
          option.textContent = name === 'openai' ? 'OpenAI' : 'Gemini';
          return option;
        }),
      );
    }
    ui.providerSelect.value = provider;
    if (capabilities.advisoryLimit)
      ui.providerSelect.title = `Changing provider reconnects voice if it is on. ${capabilities.advisoryLimit}`;
    ui.root.dataset.provider = provider;
    ui.providerSelect.addEventListener('change', providerHandler);
  }
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (ui.costSettings) ui.costSettings.hidden = !capabilities.costControls;
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', 'Toggle voice control');
    if (ui.helpDetail) ui.helpDetail.textContent = 'Activate to toggle voice';
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  controls.ui = ui;
  controls.setVoiceSettingsOpen = setSettingsOpen;
  const unavailablePanel = () => ({
    ok: false,
    changed: false,
    reason: session.disposed ? 'disposed' : 'unavailable',
    error: 'The shared voice panel is unavailable.',
    view: null,
    panelOpen: false,
    settingsOpen: false,
    previewVisible: false,
    previewEnabled: false,
  });
  controls.selectVoicePanelView = (view) =>
    panel?.select(view) ?? unavailablePanel();
  controls.closeVoicePanelView = (view) =>
    panel?.close(view) ?? unavailablePanel();
  controls.deferVoiceSettingsUntilCockpitExit = () =>
    deferredSettings.schedule();
  controls.cancelDeferredVoiceSettings = () => deferredSettings.cancel();
  controls.setVoiceInactivityMinutes = (minutes) =>
    settingsUnsubscribe.setPreference?.(minutes) ?? false;
  controls.getVoiceInactivityMinutes = () =>
    settingsUnsubscribe.getPreference?.();
  const updateStatus = session.subscribe((event) => {
    // The unified panel waits for understood intent, never microphone activity.
    panel?.handle(event);
    if (!panel && event.type === 'interruption')
      settingsUnsubscribe.yieldToVoice?.();
    // Terminal disclosure closes before a pending replacement can remount it.
    if (
      event.type === 'stop' ||
      (event.type === 'state' && ['idle', 'error'].includes(event.state))
    ) {
      deferredSettings.cancel();
      if (!panel) settingsUnsubscribe.setOpen?.(false);
    }
    onSessionEvent?.(event);
    if (event.type !== 'state') return;
    ui.root.dataset.status = event.state;
    ui.status.textContent =
      event.state === 'idle' ? 'OFF' : event.state.toUpperCase();
    ui.detail.textContent =
      event.detail || (event.state === 'idle' ? 'Voice off' : 'Voice active');
    ui.button.setAttribute('aria-pressed', String(session.isActive()));
    if (ui.errorDetail)
      ui.errorDetail.textContent =
        event.state === 'error'
          ? event.detail || 'Voice could not be started.'
          : '';
    if (ui.errorHint)
      ui.errorHint.textContent =
        event.state === 'error' && event.recovery
          ? event.recovery
          : DEFAULT_ERROR_HINT;
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
  });
  // Captions, plan and result card nested in the control; it only reads
  // provider-neutral session events.
  const card = ui.card
    ? createCard({ root: ui.root, onRender: () => panel?.sync() })
    : null;
  const previewUnsubscribe = bindVoicePreviewSettings({
    ui,
    card,
    storage,
    initialEnabled: voicePreviewEnabled,
  });
  const updateCard = card
    ? session.subscribe((event) => card.handle(event))
    : null;
  controls.voiceCard = card;
  panel = createVoicePanelControls({
    ui,
    card,
    getPreviewEnabled: () => previewUnsubscribe.getEnabled(),
    initialSettingsOpen: voiceSettingsOpen,
    onPresentationIntent: () => deferredSettings.cancel(),
  });
  const supportedPanelHost = () => {
    const dock = ui.root?.parentElement;
    return Boolean(
      dock?.id === 'command-dock' &&
      ui.root.id === 'gev-voice-control' &&
      ui.providerField?.parentElement === dock &&
      ui.providerField.classList?.contains('gev-voice-provider-field') &&
      ui.card?.classList?.contains('gev-voice-card') &&
      ui.voiceSettingsPanel?.classList?.contains('gev-voice-settings-panel') &&
      ui.root.contains?.(ui.card) &&
      ui.providerField.contains?.(ui.voiceSettingsPanel),
    );
  };
  const visible = (element) =>
    Boolean(
      element &&
      !element.hidden &&
      element.isConnected !== false &&
      element.checkVisibility?.({
        checkOpacity: true,
        checkVisibilityCSS: true,
      }) !== false,
    );
  const readPanelOrder = () => {
    if (panel) return panel.snapshot();
    const active = !session.disposed;
    const settingsOpen =
      active && visible(ui.voiceSettingsPanel) && visible(ui.providerField);
    const previewEnabled = card?.enabled === true;
    const previewVisible =
      active &&
      previewEnabled &&
      visible(ui.card) &&
      visible(ui.root) &&
      ui.root.dataset.status !== 'error';
    const settingsFront =
      ui.voiceSettingsPanel?.getAttribute?.('data-voice-settings-front') ===
      'true';
    const frontPanelId = !supportedPanelHost()
      ? null
      : settingsOpen && (settingsFront || !previewVisible)
        ? 'voice-settings'
        : previewVisible
          ? 'voice-preview'
          : null;
    return { frontPanelId, settingsOpen, previewVisible, previewEnabled };
  };
  controls.getVoicePanelOrderState = readPanelOrder;
  controls.getVoicePreviewEnabled = () =>
    session.disposed ? undefined : previewUnsubscribe.getEnabled();
  controls.setVoicePreviewEnabled = (enabled) => {
    if (session.disposed)
      return {
        ok: false,
        enabled: null,
        changed: false,
        reason: 'disposed',
        error: 'Voice Preview controls are no longer available.',
      };
    return {
      ...previewUnsubscribe.setEnabled(enabled),
      previewVisible: readPanelOrder().previewVisible,
    };
  };
  controls.setVoicePanelOrder = (panelId, position) => {
    const refuse = (reason, error) => ({
      ok: false,
      panelId,
      position,
      reason,
      error,
      ...readPanelOrder(),
    });
    if (session.disposed)
      return refuse('disposed', 'Voice controls are no longer available.');
    if (!['voice-preview', 'voice-settings'].includes(panelId))
      return refuse('unknown-panel', 'Choose Voice Preview or Voice Settings.');
    if (!['front', 'back'].includes(position))
      return refuse(
        'invalid-position',
        'Choose front or back for panel order.',
      );
    if (panel) {
      const target =
        (panelId === 'voice-settings') === (position === 'front')
          ? 'settings'
          : 'preview';
      return {
        panelId,
        position,
        compatibility: 'view-selection',
        ...panel.select(target),
      };
    }
    if (!card || !ui.card)
      return refuse('preview-unavailable', 'Voice Preview is not available.');
    if (!card.enabled)
      return refuse(
        'preview-disabled',
        'Voice Preview is disabled. Enable it before changing panel order.',
      );
    if (!ui.voiceSettingsPanel || !settingsUnsubscribe.setOrder)
      return refuse('settings-unavailable', 'Voice Settings is not available.');
    if (!supportedPanelHost())
      return refuse(
        'unsupported-host',
        'Panel ordering is only available in the shared command dock.',
      );
    const before = readPanelOrder();
    if (!before.settingsOpen)
      return refuse(
        'settings-closed',
        'Open Voice Settings before changing panel order.',
      );
    if (!before.previewVisible)
      return refuse(
        'preview-hidden',
        'Voice Preview is not visible. Wait for a voice preview before changing panel order.',
      );
    const settingsFront =
      (panelId === 'voice-settings') === (position === 'front');
    settingsUnsubscribe.setOrder(settingsFront);
    const state = readPanelOrder();
    return {
      ok: true,
      panelId,
      position,
      changed: before.frontPanelId !== state.frontPanelId,
      ...state,
    };
  };
  // Point-and-ask: the reticle follows turn events; pointer and referents are
  // session-scoped, so a session that ends forgets both.
  const reticle = pointer ? createReticle(pointer) : null;
  const updatePointer = session.subscribe((event) => {
    reticle?.handle(event);
    if (event.type === 'state' && ['idle', 'error'].includes(event.state)) {
      pointer?.clear();
      referents?.clear();
      // Conversation memory ("those", "the last answer") ends with the
      // session.
      runner.resetConversation?.();
    }
  });
  controls.pointer = pointer;
  controls.referents = referents;
  const annotationUnsubscribe = annotations?.onOutlineEvent?.((event) => {
    card?.outline(event);
    session.sendMapEvent({ type: 'map_annotation_outline', ...event });
  });
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    if (session.isActive()) {
      if (!panel) settingsUnsubscribe.setOpen?.(false);
      session.stop();
    } else void session.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', buttonHandler);
  session.signal.addEventListener(
    'abort',
    () => {
      ui.button.removeEventListener('click', buttonHandler);
      ui.providerSelect?.removeEventListener('change', providerHandler);
      settingsUnsubscribe();
      previewUnsubscribe();
      deferredSettings.destroy();
      inactivityUnsubscribe();
      inactivity.destroy();
      annotationUnsubscribe?.();
      updateStatus();
      ui.providerField?.remove?.();
      updateCard?.();
      updatePointer();
      reticle?.destroy();
      card?.destroy();
      panel?.destroy();
      pointer?.clear();
      referents?.clear();
      runner.resetConversation?.();
      if (disposeRunner) runner.dispose?.();
      ui.root.remove();
    },
    { once: true },
  );
  if (session.disposed) {
    ui.button.removeEventListener('click', buttonHandler);
    ui.providerSelect?.removeEventListener('change', providerHandler);
    settingsUnsubscribe();
    previewUnsubscribe();
    deferredSettings.destroy();
    inactivityUnsubscribe();
    inactivity.destroy();
    annotationUnsubscribe?.();
    updateStatus();
    ui.providerField?.remove?.();
    updateCard?.();
    updatePointer();
    reticle?.destroy();
    card?.destroy();
    panel?.destroy();
    pointer?.clear();
    referents?.clear();
    runner.resetConversation?.();
    if (disposeRunner) runner.dispose?.();
    ui.root.remove();
  } else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
