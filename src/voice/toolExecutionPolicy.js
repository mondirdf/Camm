import { readLayerLifecycleSummary } from './layerSummary.js';
import {
  responseInstructionForToolResult,
  shouldStopVoiceAfterRadioTool,
} from './realtimeProtocol.js';

/** Shared application authority; provider adapters retain transport ownership. */
export function classifyVoiceTool(name, args = {}) {
  const radioControl = name === 'control_radio';
  const radioVisibility =
    name === 'set_layer_visibility' &&
    String(args.layerId || '')
      .trim()
      .toLowerCase() === 'radio';
  const radioAction = radioControl
    ? String(args.action || '')
        .trim()
        .toLowerCase()
    : null;
  const authorityDomain =
    radioVisibility || ['enable', 'disable'].includes(radioAction)
      ? 'visibility'
      : radioAction === 'status'
        ? 'query'
        : radioControl
          ? 'playback'
          : null;
  const stronger =
    (radioControl && ['disable', 'pause', 'stop'].includes(radioAction)) ||
    (radioVisibility && args.enabled === false);
  return {
    radioControl,
    radioVisibility,
    radioAction,
    authorityDomain,
    stronger,
    abortScope:
      radioAction === 'disable' || radioVisibility ? 'all' : 'playback',
  };
}

/** Prepared playback hands off only after confirmation and playback readiness. */
export function shouldStopVoiceAfterToolResult(result) {
  return Boolean(
    shouldStopVoiceAfterRadioTool(result) &&
    !result.radioPlaybackRequested &&
    !result.radioPlaybackSuppressed,
  );
}

/** Read after stronger authority commits, including failure/abort envelopes. */
export function reconcileRadioToolResult(
  result,
  { dataManager, radioLayer, suppressPlayback = false } = {},
) {
  const radioResult =
    result?.action === 'control_radio' ||
    result?.tool === 'control_radio' ||
    ((result?.action === 'set_layer_visibility' ||
      result?.tool === 'set_layer_visibility') &&
      String(result.layerId || '')
        .trim()
        .toLowerCase() === 'radio');
  if (!radioResult) return result;
  let state;
  try {
    state = radioLayer?.getUIState?.() || {};
  } catch {
    state = {};
  }
  const lifecycle = readLayerLifecycleSummary(dataManager, 'radio', {
    fallbackEnabled: state.enabled ?? result.enabled,
  });
  return {
    ...result,
    ...lifecycle,
    audioState: state.audioState || result.audioState || 'stopped',
    ...(result.radioAction === 'pause' && lifecycle.enabled === false
      ? { changed: false }
      : {}),
    ...(suppressPlayback && result.ok && result.radioPlaybackRequested
      ? { radioPlaybackRequested: false, radioPlaybackSuppressed: true }
      : {}),
  };
}

/** Guidance is authored code; provider/lookup text remains inert result data. */
export function toolResultGuidance(result) {
  if (!result || typeof result !== 'object')
    return responseInstructionForToolResult(null);
  // The legacy zoom policy interpolates these two fields. Constrain the only
  // variable instruction fragment and never embed an arbitrary error message.
  return responseInstructionForToolResult({
    ...result,
    direction: ['in', 'out'].includes(result.direction)
      ? result.direction
      : 'as requested',
    error: 'The requested action could not be completed.',
  });
}
