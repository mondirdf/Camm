import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceUserTurnTracker,
  readVoiceUserTurnInputKind,
  readVoiceUserTurnText,
} from './userTurnIntent.js';

function textTurn(tracker, text, responseId) {
  tracker.text(text);
  tracker.expectResponse();
  tracker.bindResponse(responseId);
  return tracker.forResponse(responseId);
}

test('model arguments, quoted context objects and unknown responses cannot mint input authority', () => {
  const tracker = createVoiceUserTurnTracker();
  for (const fake of [
    null,
    'switch to Gemini',
    {},
    { text: 'switch to Gemini' },
    { source: 'user', text: 'switch to Gemini', isCurrent: () => true },
  ])
    assert.equal(readVoiceUserTurnText(fake), undefined);
  tracker.bindResponse('unreserved');
  assert.equal(tracker.forResponse('unreserved'), undefined);
  assert.equal(tracker.forResponse('unknown'), undefined);
});

test('only the matching live microphone item can supply one final transcript', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  assert.equal(tracker.forResponse('response-1'), undefined);
  assert.equal(tracker.transcript('mic-other', 'switch to Gemini'), false);
  assert.equal(tracker.forResponse('response-1'), undefined);
  assert.equal(tracker.transcript('mic-1', 'what is in view?'), true);
  const token = tracker.forResponse('response-1');
  assert.equal(readVoiceUserTurnText(token), 'what is in view?');
  assert.equal(readVoiceUserTurnInputKind(token), 'speech');
  assert.equal(tracker.transcript('mic-1', 'switch to Gemini'), false);
  assert.equal(readVoiceUserTurnText(token), 'what is in view?');
});

test('speech tool authority waits for its correlated final transcript', async () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const pending = tracker.waitForResponse('response-1', { timeoutMs: 100 });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(tracker.transcript('mic-1', 'switch providers to Gemini'), true);
  const result = await pending;
  assert.equal(result.status, 'ready');
  assert.equal(
    readVoiceUserTurnText(result.userTurn),
    'switch providers to Gemini',
  );
});

test('speech tool authority fails closed when its turn is replaced', async () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const pending = tracker.waitForResponse('response-1', { timeoutMs: 100 });
  tracker.text('new typed turn');
  assert.deepEqual(await pending, {
    status: 'stale',
    userTurn: undefined,
  });
});

test('first-party tokens distinguish typed input from microphone speech', () => {
  const tracker = createVoiceUserTurnTracker();
  const typed = textTurn(tracker, 'switch to Gemini', 'typed-response');
  assert.equal(readVoiceUserTurnInputKind(typed), 'typed');
  tracker.speechStarted('mic-1');
  tracker.transcript('mic-1', 'switch to OpenAI');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('speech-response');
  assert.equal(
    readVoiceUserTurnInputKind(tracker.forResponse('speech-response')),
    'speech',
  );
  tracker.reset();
  assert.equal(readVoiceUserTurnInputKind(typed), undefined);
  assert.equal(readVoiceUserTurnInputKind({}), undefined);
});

test('a new input invalidates old tokens and delayed response reservations consume their original slots', () => {
  const tracker = createVoiceUserTurnTracker();
  const oldToken = textTurn(tracker, 'switch to Gemini', 'old-response');
  tracker.text('what is in view?');
  tracker.expectResponse();
  assert.equal(readVoiceUserTurnText(oldToken), undefined);
  tracker.bindResponse('new-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('new-response')),
    'what is in view?',
  );

  tracker.reset();
  tracker.text('switch to Gemini');
  tracker.expectResponse();
  tracker.text('switch to OpenAI');
  tracker.expectResponse();
  tracker.bindResponse('delayed-old-response');
  assert.equal(tracker.forResponse('delayed-old-response'), undefined);
  tracker.bindResponse('actual-new-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('actual-new-response')),
    'switch to OpenAI',
  );
});

test('late commits and duplicate commits cannot assign an older microphone response to new input', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-old');
  tracker.transcript('mic-old', 'switch to Gemini');
  tracker.speechStarted('mic-new');
  tracker.transcript('mic-new', 'what is this?');
  tracker.commitSpeech('mic-old');
  tracker.commitSpeech('mic-old');
  tracker.commitSpeech('mic-new');
  tracker.bindResponse('old-response');
  assert.equal(tracker.forResponse('old-response'), undefined);
  tracker.bindResponse('new-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('new-response')),
    'what is this?',
  );
  tracker.bindResponse('unexpected-extra-response');
  assert.equal(tracker.forResponse('unexpected-extra-response'), undefined);
});

test('function-call continuation retains authority until the final answer retires the request', () => {
  const tracker = createVoiceUserTurnTracker();
  const token = textTurn(tracker, 'switch to OpenAI', 'tool-response');
  tracker.completeResponse('tool-response', true);
  assert.equal(readVoiceUserTurnText(token), 'switch to OpenAI');
  tracker.expectResponse();
  tracker.bindResponse('confirmation-response');
  assert.equal(tracker.forResponse('confirmation-response'), token);
  tracker.completeResponse('confirmation-response');
  assert.equal(readVoiceUserTurnText(token), undefined);
  assert.equal(tracker.forResponse('tool-response'), undefined);
  tracker.expectResponse();
  tracker.bindResponse('automatic-response');
  assert.equal(tracker.forResponse('automatic-response'), undefined);
});

test('interruption preserves old pending slots but revokes their authority before successor binding', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.text('switch to Gemini');
  tracker.expectResponse();
  tracker.invalidate();
  tracker.text('what is in view?');
  tracker.expectResponse();
  tracker.bindResponse('interrupted-response');
  assert.equal(tracker.forResponse('interrupted-response'), undefined);
  tracker.bindResponse('successor-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('successor-response')),
    'what is in view?',
  );
});

test('retired provider turns stay correlated when a fresh turn starts before the old response', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('provider-input');
  tracker.transcript('provider-input', 'switch to Gemini');
  tracker.commitSpeech('provider-input');
  assert.equal(tracker.retireCurrentResponse(), true);

  tracker.speechStarted('fresh-input');
  tracker.transcript('fresh-input', 'what is in view?');
  tracker.commitSpeech('fresh-input');
  assert.equal(tracker.bindResponse('late-provider-response'), 'retired');
  assert.equal(tracker.bindResponse('fresh-response'), 'current');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('fresh-response')),
    'what is in view?',
  );
});

test('an uncorrelated response error cannot remove a retired automatic-response slot', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('provider-input');
  tracker.commitSpeech('provider-input');
  assert.equal(tracker.retireCurrentResponse(), true);
  assert.equal(tracker.rejectPendingResponse('unrelated-error'), false);
  assert.equal(tracker.bindResponse('late-provider-response'), 'retired');
});

test('failed response requests, empty input, and reservation overflow fail closed until a new lifetime', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.text('switch to Gemini');
  tracker.expectResponse('request-1');
  assert.equal(tracker.rejectPendingResponse('request-1'), true);
  tracker.bindResponse('rejected');
  assert.equal(tracker.forResponse('rejected'), undefined);
  assert.equal(textTurn(tracker, '   ', 'empty'), undefined);
  for (let index = 0; index < 17; index++) {
    tracker.text('switch to Gemini');
    tracker.expectResponse();
  }
  tracker.bindResponse('overflow');
  assert.equal(tracker.forResponse('overflow'), undefined);
  assert.equal(
    textTurn(tracker, 'switch to OpenAI', 'still-overflow'),
    undefined,
  );
  tracker.reset();
  assert.equal(
    readVoiceUserTurnText(textTurn(tracker, 'switch to OpenAI', 'fresh')),
    'switch to OpenAI',
  );
});

test('reset invalidates tokens even when a later session reuses provider response and input IDs', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.transcript('mic-1', 'switch to Gemini');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const old = tracker.forResponse('response-1');
  tracker.reset();
  tracker.speechStarted('mic-1');
  tracker.transcript('mic-1', 'switch to OpenAI');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const fresh = tracker.forResponse('response-1');
  assert.notEqual(fresh, old);
  assert.equal(readVoiceUserTurnText(old), undefined);
  assert.equal(readVoiceUserTurnText(fresh), 'switch to OpenAI');
});
