import { readVoiceUserTurnText } from './userTurnIntent.js';

export const VOICE_PROVIDER_GUIDANCE =
  'I can’t switch voice providers directly. Hover over the Voice panel and use the provider dropdown.';

/** Provider policy consumes only current, first-party input provenance. */
export function readVoiceProviderRequest(userTurn) {
  return readVoiceProviderRequestText(readVoiceUserTurnText(userTurn));
}

/** Parse one direct first-party command. Callers own the input provenance. */
export function readVoiceProviderRequestText(input) {
  if (typeof input !== 'string' || !input || input.length > 500)
    return undefined;
  const text = input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
  const prefix =
    '(?:(?:please,? (?:(?:can|could|would) you )?)|(?:(?:can|could|would) you(?: please)? ))?';
  const knownProvider = '(open ?ai|gemini)';
  const explicitProvider = '([a-z][a-z0-9-]*(?: [a-z0-9-]+){0,2}?)';
  const suffix = '(?:,? please)?';
  if (
    new RegExp(
      `^${prefix}(?:choose|switch|change|select) (?:(?:the|my|a) )?(?:voice )?providers?${suffix}$`,
    ).test(text)
  )
    return 'provider';
  const patterns = [
    `use ${knownProvider}(?: for voice| as (?:the |my )?voice provider)?`,
    `use ${explicitProvider} as (?:the |my )?voice provider`,
    `(?:switch|change) (?:to|over to) ${knownProvider}`,
    `(?:switch|change) (?:(?:(?:the|my) )?(?:voice )?providers? )?from ${knownProvider} to ${knownProvider}`,
    `(?:switch|change) (?:the |my )?(?:voice(?: providers?)?|providers?) (?:to|over to) ${explicitProvider}`,
    `set (?:the |my )?(?:voice(?: provider)?|provider)(?: to)? ${explicitProvider}`,
    `set ${explicitProvider} as (?:the |my )?voice provider`,
    `select ${explicitProvider} as (?:the |my )?voice provider`,
    `make ${explicitProvider} (?:the |my )?voice provider`,
  ];
  const requested = patterns
    .map((pattern) => {
      const matches = new RegExp(`^${prefix}${pattern}${suffix}$`).exec(text);
      return matches?.at(-1)?.trim();
    })
    .find(Boolean);
  if (
    !requested ||
    /\b(?:and|or|but|if|unless|when|then|not|never|maybe|explain|tell|say|quote)\b/.test(
      requested,
    )
  )
    return undefined;
  return requested.replace(/\s+/g, '');
}

/** Code-authored guidance contract; voice never changes the selected provider. */
export function providerManualConfirmationSay() {
  return VOICE_PROVIDER_GUIDANCE;
}

/** Retained for compatibility with older callers; all routes give one answer. */
export function providerSwitchSay() {
  return providerManualConfirmationSay();
}

export function providerUnavailableSay() {
  return providerManualConfirmationSay();
}

/** Return the non-mutating result shared by every model tool surface. */
export function providerRequestGuidanceResult(action) {
  return {
    ok: false,
    action,
    changed: false,
    providerRequestBlocked: true,
    error: VOICE_PROVIDER_GUIDANCE,
    say: VOICE_PROVIDER_GUIDANCE,
  };
}
