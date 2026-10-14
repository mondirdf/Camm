export const VOICE_PREVIEW_STORAGE_KEY = 'godsEyeView.voice.previewEnabled';

/** Bind a browser-local presentation preference independently of voice input. */
export function bindVoicePreviewSettings({
  ui,
  card,
  storage,
  initialEnabled,
}) {
  const input = ui.voicePreviewInput;
  const stored = () =>
    storage === undefined ? globalThis.localStorage : storage;
  let enabled = true;
  let disposed = false;
  if (typeof initialEnabled === 'boolean') enabled = initialEnabled;
  else {
    try {
      enabled = stored()?.getItem?.(VOICE_PREVIEW_STORAGE_KEY) !== 'false';
    } catch {
      /* Storage is optional; the preview defaults to enabled. */
    }
  }
  card?.setEnabled?.(enabled);
  if (input) input.checked = enabled;
  const available = () =>
    typeof card?.setEnabled === 'function' &&
    card.destroyed !== true &&
    ui.root?.isConnected !== false &&
    (!('card' in ui) || Boolean(ui.card && ui.card.isConnected !== false)) &&
    (card.elements === undefined ||
      Boolean(card.elements?.card && card.elements.card.isConnected !== false));
  const getEnabled = () => (!disposed && available() ? enabled : undefined);
  const refuse = (reason, error) => ({
    ok: false,
    enabled: getEnabled() ?? null,
    changed: false,
    reason,
    error,
  });
  const setEnabled = (next) => {
    if (disposed)
      return refuse(
        'disposed',
        'Voice Preview controls are no longer available.',
      );
    if (typeof next !== 'boolean')
      return refuse(
        'invalid-enabled',
        'Voice Preview enabled must be true or false.',
      );
    if (!available())
      return refuse('preview-unavailable', 'Voice Preview is not available.');
    const changed = next !== enabled;
    enabled = next;
    if (input) input.checked = enabled;
    card.setEnabled(enabled);
    let persisted = false;
    try {
      const target = stored();
      if (typeof target?.setItem === 'function') {
        target.setItem(VOICE_PREVIEW_STORAGE_KEY, String(enabled));
        persisted =
          target.getItem?.(VOICE_PREVIEW_STORAGE_KEY) === String(enabled);
      }
    } catch {
      /* The current preference still works when persistence is unavailable. */
    }
    return { ok: true, enabled, changed, persisted };
  };
  const change = () => {
    const result = setEnabled(input.checked);
    if (!result.ok && !disposed) input.checked = enabled;
  };
  input?.addEventListener('change', change);
  const unsubscribe = () => {
    disposed = true;
    input?.removeEventListener('change', change);
  };
  unsubscribe.setEnabled = setEnabled;
  unsubscribe.getEnabled = getEnabled;
  return unsubscribe;
}
