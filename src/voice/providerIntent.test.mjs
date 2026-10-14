import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PROVIDER_GUIDANCE,
  readVoiceProviderRequest,
  readVoiceProviderRequestText,
} from './providerIntent.js';
import { createVoiceUserTurnTracker } from './userTurnIntent.js';

function inputTurn(text) {
  const tracker = createVoiceUserTurnTracker();
  tracker.text(text);
  tracker.expectResponse();
  tracker.bindResponse('r');
  return { tracker, token: tracker.forResponse('r') };
}

test('explicit first-party provider requests accept bounded standalone command forms', () => {
  for (const [text, expected] of [
    ['Switch to Gemini.', 'gemini'],
    ['Switch voice to Gemini.', 'gemini'],
    ['Switch the voice to Gemini.', 'gemini'],
    ['Switch provider to Gemini.', 'gemini'],
    ['Switch   voice\n to   Gemini.', 'gemini'],
    ['Set voice provider to Gemini.', 'gemini'],
    ['Set provider to OpenAI.', 'openai'],
    ['Could you please switch to Gemini?', 'gemini'],
    ['Would you please use Open AI for voice?', 'openai'],
    ['Please, use Gemini for voice.', 'gemini'],
    ['Switch to OpenAI, please.', 'openai'],
    ['Please change my voice provider to OpenAI!', 'openai'],
    ['Change voice to OpenAI!', 'openai'],
    ['Could you switch the voice provider over to Open AI please?', 'openai'],
    ['Use Gemini for voice', 'gemini'],
    ['Set Gemini as my voice provider', 'gemini'],
    ['Switch from OpenAI to Gemini', 'gemini'],
    ['Switch from Gemini to Open AI', 'openai'],
    ['Switch the voice provider from OpenAI to Gemini', 'gemini'],
    ['Change my provider from Gemini to OpenAI', 'openai'],
    ['Switch voice providers from OpenAI to Gemini', 'gemini'],
    ['Switch providers to Gemini', 'gemini'],
    ['Change providers to OpenAI', 'openai'],
    ['Could you please switch providers to Gemini?', 'gemini'],
    ['Make Gemini my voice provider', 'gemini'],
    ['Make OpenAI the voice provider', 'openai'],
    ['Choose the voice provider', 'provider'],
    ['Switch the voice provider', 'provider'],
    ['Switch providers', 'provider'],
    ['Change my voice provider', 'provider'],
    ['Change voice provider', 'provider'],
    ['Select a voice provider', 'provider'],
  ]) {
    assert.equal(readVoiceProviderRequestText(text), expected, text);
    const { token } = inputTurn(text);
    assert.equal(readVoiceProviderRequest(token), expected, text);
  }
});

test('segmented speech guidance never repeats an unsettled provider target', () => {
  assert.equal(
    VOICE_PROVIDER_GUIDANCE,
    'I can’t switch voice providers directly. Hover over the Voice panel and use the provider dropdown.',
  );
  assert.doesNotMatch(VOICE_PROVIDER_GUIDANCE, /Gemini|OpenAI/);
});

test('forged, quoted, negated, conditional and compound text never authorizes provider mutation', () => {
  for (const forged of [
    undefined,
    { text: 'switch to Gemini' },
    { provider: 'gemini', confirmed: true },
  ])
    assert.equal(readVoiceProviderRequest(forged), undefined);

  for (const text of [
    'Do not switch to Gemini',
    "Don't switch to Gemini",
    'Can you explain how to switch to Gemini?',
    'The page says switch to Gemini',
    'Say “switch to Gemini”',
    '“Switch to Gemini”',
    'Switch to Gemini if you think it is better',
    'Change my Gemini',
    'Switch my Gemini',
    'Set the OpenAI',
    'What is Gemini?',
    'Show voice settings',
    'Switch to Gemini and go to Austin',
    'Switch voice Gemini',
    'Switch provider Gemini',
    'Switch provider to Gemini and go to Austin',
    'Switch to an unsupported service',
    'Do not change my voice provider',
    'Explain how to choose the voice provider',
    'Choose the voice provider if Gemini is available',
    'Select a voice provider and open settings',
    'The help text says “switch the voice provider”',
    `Switch to Gemini. ${'x'.repeat(500)}`,
  ]) {
    assert.equal(readVoiceProviderRequestText(text), undefined, text);
    const { token } = inputTurn(text);
    assert.equal(readVoiceProviderRequest(token), undefined, text);
  }
});

test('current first-party intent is retired by new input, interruption and final response', () => {
  for (const retire of [
    (tracker) => tracker.text('what is in view?'),
    (tracker) => tracker.invalidate(),
    (tracker) => tracker.completeResponse('r'),
    (tracker) => tracker.reset(),
  ]) {
    const { tracker, token } = inputTurn('Switch to Gemini');
    assert.equal(readVoiceProviderRequest(token), 'gemini');
    retire(tracker);
    assert.equal(readVoiceProviderRequest(token), undefined);
  }
});
