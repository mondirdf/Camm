/** A single presentation owner for the provider-neutral Preview/Settings panel. */
export function createVoicePanelControls({
  ui,
  card,
  getPreviewEnabled,
  initialSettingsOpen = false,
  onPresentationIntent,
}) {
  if (!ui.voicePanel) return null;
  const panel = ui.voicePanel;
  const tabs = [ui.previewTab, ui.settingsTab];
  const lifetime = new AbortController();
  let disposed = false;
  let open = initialSettingsOpen;
  let view = initialSettingsOpen ? 'settings' : 'preview';
  let revision = 0;
  let turnRevision = 0;
  let turnIntent = null;
  let turnStarted = false;
  let turnComplete = false;
  let turnFinalReceived = false;
  let active = false;
  let horizontalShift = 0;
  const viewWindow = panel.ownerDocument?.defaultView ?? globalThis.window;
  const layout = () => {
    if (disposed || !open || !panel.getBoundingClientRect || !panel.style)
      return;
    const width = viewWindow?.innerWidth;
    if (!Number.isFinite(width)) return;
    const rect = panel.getBoundingClientRect();
    const anchoredLeft = rect.left - horizontalShift;
    const left = Math.max(12, Math.min(anchoredLeft, width - 12 - rect.width));
    const shift = left - anchoredLeft;
    if (shift === horizontalShift) return;
    horizontalShift = shift;
    panel.style.setProperty('--voice-panel-shift-x', `${shift}px`);
  };
  const enabled = () => getPreviewEnabled() === true;
  const setHidden = (element, hidden) => {
    if (element && element.hidden !== hidden) element.hidden = hidden;
  };
  const setAttribute = (element, name, value) => {
    if (element && element.getAttribute?.(name) !== value)
      element.setAttribute(name, value);
  };
  const activeElement = () =>
    panel.ownerDocument?.activeElement ?? globalThis.document?.activeElement;
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
  const snapshot = () => {
    const panelOpen = !disposed && open && visible(panel);
    const settingsOpen = panelOpen && view === 'settings';
    const previewVisible =
      panelOpen && view === 'preview' && enabled() && visible(ui.card);
    return {
      view,
      panelOpen,
      settingsOpen,
      previewVisible,
      previewEnabled: enabled(),
      // Compatibility: this identifies the selected view, not a stacking order.
      frontPanelId: panelOpen ? `voice-${view}` : null,
    };
  };
  const sync = () => {
    if (disposed) return;
    const wasOpen = !panel.hidden;
    setHidden(panel, !open);
    if (panel.dataset.view !== view) panel.dataset.view = view;
    setHidden(ui.previewPanel, !open || view !== 'preview');
    setHidden(ui.voiceSettingsPanel, !open || view !== 'settings');
    // Keep the one alert in the visible scroll area while the panel is open.
    // When closed it returns to its standalone tray above the microphone.
    const errorParent = open
      ? view === 'preview'
        ? ui.previewPanel
        : ui.voiceSettingsPanel
      : ui.root;
    if (
      ui.errorTray &&
      errorParent &&
      ui.errorTray.parentNode !== errorParent
    ) {
      if (open) errorParent.prepend(ui.errorTray);
      else errorParent.append(ui.errorTray);
    }
    setAttribute(
      ui.voiceSettingsButton,
      'aria-expanded',
      String(open && view === 'settings'),
    );
    tabs.forEach((tab, index) => {
      const selected = view === (index === 0 ? 'preview' : 'settings');
      setAttribute(tab, 'aria-selected', String(selected));
      const tabIndex = selected ? 0 : -1;
      if (tab && tab.tabIndex !== tabIndex) tab.tabIndex = tabIndex;
    });
    card?.setPresented?.(open && view === 'preview');
    if (ui.previewEmpty) {
      // The card has already rendered; reading its hidden flag avoids deriving
      // the entire caption/result view a second time for every audio delta.
      setHidden(ui.previewEmpty, Boolean(ui.card && !ui.card.hidden));
      const message = enabled()
        ? 'Speak to see captions and results.'
        : 'Voice Preview is off. Enable Voice preview in Settings.';
      if (ui.previewEmpty.textContent !== message)
        ui.previewEmpty.textContent = message;
    }
    if (open && !wasOpen) layout();
  };
  const refuse = (reason, error) => ({
    ok: false,
    changed: false,
    reason,
    error,
    ...snapshot(),
  });
  const select = (next, { source = 'api', focus = false } = {}) => {
    if (disposed)
      return refuse('disposed', 'Voice controls are no longer available.');
    if (!['preview', 'settings'].includes(next))
      return refuse('unknown-view', 'Choose Preview or Settings.');
    const changed = !open || next !== view;
    const outgoing =
      view === 'preview' ? ui.previewPanel : ui.voiceSettingsPanel;
    const transferFocus = changed && outgoing?.contains?.(activeElement());
    if (source !== 'intent' && source !== 'activation') {
      revision++;
      onPresentationIntent?.();
    }
    open = true;
    view = next;
    sync();
    if (focus || transferFocus) tabs[next === 'preview' ? 0 : 1]?.focus?.();
    return { ok: true, changed, ...snapshot() };
  };
  const close = (onlyView) => {
    if (disposed)
      return refuse('disposed', 'Voice controls are no longer available.');
    if (onlyView && !['preview', 'settings'].includes(onlyView))
      return refuse('unknown-view', 'Choose Preview or Settings.');
    if (onlyView && (onlyView !== view || (onlyView === 'preview' && !open)))
      return { ok: true, changed: false, ...snapshot() };
    // A close request also cancels a pending reveal, even before it is visible.
    revision++;
    onPresentationIntent?.();
    const changed = open && (!onlyView || view === onlyView);
    if (changed) {
      const restoreFocus = panel.contains?.(activeElement());
      open = false;
      sync();
      if (restoreFocus) ui.voiceSettingsButton?.focus?.();
    }
    return { ok: true, changed, ...snapshot() };
  };
  const beginTurn = () => {
    turnRevision = revision;
    turnStarted = true;
    turnComplete = false;
    turnFinalReceived = false;
    turnIntent = null;
  };
  const acceptIntent = (intent) => {
    if (!intent || turnRevision !== revision) return;
    // An authoritative settings action wins over a delayed final transcript.
    if (turnIntent === 'settings' && intent === 'preview') return;
    turnIntent = intent;
    if (intent === 'settings' || enabled())
      select(intent, { source: 'intent' });
  };
  const handle = (event) => {
    if (disposed) return;
    if (event.type === 'interruption' && active) {
      beginTurn();
      return;
    }
    if (event.type === 'state' && event.state === 'connecting') {
      active = true;
      beginTurn();
      if (!(open && view === 'settings') && enabled())
        select('preview', { source: 'activation' });
      return;
    }
    if (
      event.type === 'stop' ||
      (event.type === 'state' && ['idle', 'error'].includes(event.state))
    ) {
      active = false;
      turnStarted = false;
      turnComplete = false;
      turnFinalReceived = false;
      turnIntent = null;
      // Configuration remains available when voice is off or cannot connect.
      if (view === 'preview') {
        open = false;
        sync();
      }
      return;
    }
    // Only a new start can rearm after Stop. A late adapter status is not
    // evidence of renewed user intent or an authorized microphone lifetime.
    if (!active) return;
    if (event.type === 'completion' || event.type === 'reply-complete') {
      turnComplete = true;
      return;
    }
    if (event.type === 'transcript' && event.role === 'user') {
      // OpenAI can finish the response just before its input transcription.
      // Accept that first final for the armed speech turn, then reject replay.
      if (turnComplete && event.final && turnFinalReceived) return;
      if (!turnStarted || (turnComplete && !event.final)) beginTurn();
      if (!event.final) return;
      turnFinalReceived = true;
      acceptIntent(voicePanelTranscriptIntent(event.text));
    } else if (event.type === 'action-call') {
      if (!turnStarted) return;
      acceptIntent(voicePanelActionIntent(event.name, event.arguments));
    }
  };
  const listen = (element, type, handler) =>
    element?.addEventListener(type, handler, { signal: lifetime.signal });
  listen(ui.voiceSettingsButton, 'click', () =>
    select('settings', { source: 'ui', focus: true }),
  );
  tabs.forEach((tab, index) => {
    listen(tab, 'click', () =>
      select(index === 0 ? 'preview' : 'settings', {
        source: 'ui',
        focus: true,
      }),
    );
    listen(tab, 'keydown', (event) => {
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 1
            : ['ArrowLeft', 'ArrowRight'].includes(event.key)
              ? 1 - index
              : null;
      if (next === null) return;
      event.preventDefault();
      select(next === 0 ? 'preview' : 'settings', {
        source: 'ui',
        focus: true,
      });
    });
  });
  listen(ui.voiceSettingsClose, 'click', () => close());
  listen(panel, 'keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    close();
  });
  listen(viewWindow, 'resize', layout);
  const resizeObserver =
    typeof globalThis.ResizeObserver === 'function'
      ? new ResizeObserver(layout)
      : null;
  resizeObserver?.observe(panel);
  if (ui.root) resizeObserver?.observe(ui.root);
  sync();
  return {
    select,
    close,
    snapshot,
    sync,
    handle,
    destroy() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      resizeObserver?.disconnect();
      if (ui.errorTray && ui.root && ui.errorTray.parentNode !== ui.root)
        ui.root.append(ui.errorTray);
    },
  };
}

/** Classify final input only; partial speech cannot collapse configuration. */
export function voicePanelTranscriptIntent(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (
    !words ||
    /^(yes|yeah|yep|no|nope|okay|ok|sure|cancel|please|thanks|thank you)( (please|thanks|thank you))?$/.test(
      words,
    )
  )
    return null;
  if (
    /\b(api keys?|credentials|power up)\b/.test(words) ||
    (!/\bvoice\b/.test(words) && /\bprovider settings\b/.test(words))
  )
    return null;
  // Explicit view commands belong to the guarded tool: opening may require
  // Cockpit exit, and closing must not preselect an inactive target.
  if (
    /\b(show|open|select|switch to|bring|close|hide|dismiss)\b.*\b(preview|settings|preferences)\b/.test(
      words,
    )
  )
    return null;
  // Generic settings must still pass through the model's clarification tool.
  if (
    /\b(settings|preferences)\b/.test(words) &&
    !/\b(voice|provider|openai|gemini|inactivity|timeout|microphone|mic)\b/.test(
      words,
    )
  )
    return null;
  if (
    /\b(settings|preferences|provider|openai|gemini|inactivity|timeout)\b/.test(
      words,
    ) ||
    /\b(voice|audio|microphone|mic)\b.*\b(cost|tier|preview|enable|disable|on|off)\b/.test(
      words,
    )
  )
    return 'settings';
  return 'preview';
}

/** Actual tools provide intent before Gemini's final user transcript arrives. */
export function voicePanelActionIntent(name, args = {}) {
  if (!name) return null;
  // Provider changes are manual-only. A stale or injected tool event must not
  // change the selected voice-panel view either.
  if (name === 'set_voice_provider') return null;
  // Explicit view/open/close tools apply their own authoritative result.
  if (
    name === 'set_voice_panel_order' ||
    (name === 'set_panel_open' &&
      [
        'voice-settings',
        'voice-preview',
        'settings',
        'provider-settings',
      ].includes(args?.panelId))
  )
    return null;
  return ['set_voice_inactivity_timeout', 'set_voice_preview_enabled'].includes(
    name,
  )
    ? 'settings'
    : 'preview';
}
