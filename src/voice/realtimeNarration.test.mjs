import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';
import { PROGRESS_MAX_OUTPUT_TOKENS } from './realtimeTurns.js';
import { readVoiceUserTurnText } from './userTurnIntent.js';

function controllerFixture({
  runner = async () => ({ ok: true }),
  onSessionEvent,
} = {}) {
  const sent = [];
  const statuses = [];
  const usage = [];
  const controller = new GevRealtimeController({
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: { textContent: '' },
      detail: { textContent: '', title: '' },
      errorDetail: { textContent: '' },
    },
    runner,
    debugSink: null,
    onSessionEvent,
  });
  const setStatus = controller.setStatus.bind(controller);
  controller.setStatus = (status, detail) => {
    statuses.push(status);
    return setStatus(status, detail);
  };
  const recordUsage = controller.recordUsage.bind(controller);
  controller.recordUsage = (value) => {
    if (value) usage.push(value);
    return recordUsage(value);
  };
  controller.dc = {
    readyState: 'open',
    send: (body) => sent.push(JSON.parse(body)),
    close() {},
  };
  const event = (payload) =>
    controller.handleRealtimeEvent({ data: JSON.stringify(payload) });
  // Server errors carry their own event_id; the client's id is in error.event_id.
  let serverSeq = 0;
  const rejection = (clientEventId, code = 'invalid_request_error') =>
    event({
      type: 'error',
      event_id: `event_server_${++serverSeq}`,
      error: {
        type: 'invalid_request_error',
        code,
        message: 'rejected',
        event_id: clientEventId,
      },
    });
  const progressLine = async (id = 'resp_p', line = 'Heading to Austin.') => {
    assert.equal(controller._turns.speakProgressLine(line), true);
    const request = sent.at(-1);
    await event({
      type: 'response.created',
      response: { id, metadata: { gev: 'progress' } },
    });
    return request;
  };
  return { controller, sent, statuses, usage, event, rejection, progressLine };
}

const types = (sent) => sent.map((message) => message.type);

test('Space barge-in cancels the reply and clears audio; WebRTC truncates, so no manual truncate', async () => {
  const { controller, sent, statuses, event, rejection } = controllerFixture();
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_1' });
  controller.pendingResponseInstructions = 'queued follow-up';

  assert.equal(controller._turns.bargeIn(), true);
  assert.deepEqual(types(sent), [
    'response.cancel',
    'output_audio_buffer.clear',
  ]);
  assert.equal(sent[0].response_id, 'resp_1');
  assert.equal(
    controller.pendingResponseInstructions,
    null,
    'no queued follow-up talks over the user',
  );
  assert.equal(
    controller.isSupersededResponse('resp_1'),
    true,
    'late calls from the cut reply are refused',
  );

  // The target may already have finished. The rejection names the client id
  // in error.event_id while the envelope has a different server id.
  await rejection(sent[0].event_id, 'response_cancel_not_active');
  await rejection(sent[1].event_id);
  assert.equal(statuses.includes('error'), false);
});

test('an unrelated server error with a colliding top-level id is still fatal', async () => {
  const { controller, sent, statuses, event } = controllerFixture();
  await event({ type: 'response.created', response: { id: 'resp_1' } });
  controller._turns.bargeIn();
  await event({
    type: 'error',
    event_id: sent[0].event_id,
    error: { code: 'server_error', message: 'boom' },
  });
  assert.equal(
    statuses.includes('error'),
    true,
    'only error.event_id correlates a client event',
  );
});

test('a rejected progress line releases the waiting reply without an error state', async () => {
  const { controller, sent, statuses, rejection } = controllerFixture();
  controller._turns.speakProgressLine('Heading to Austin.');
  controller.queueResponseCreate('Speak the say line.');
  assert.equal(sent.length, 1, 'the follow-up waits behind the line');
  await rejection(sent[0].event_id);
  assert.equal(statuses.includes('error'), false);
  assert.equal(sent.at(-1).type, 'response.create');
  assert.equal(sent.at(-1).response.instructions, 'Speak the say line.');
});

test('progress requests are out of band, bounded, and carry the line only as data', async () => {
  const { controller, sent } = controllerFixture();
  const line = 'Finding Texas State Capitol on the map.';
  assert.equal(controller._turns.speakProgressLine(line), true);
  const { response } = sent[0];
  assert.equal(response.conversation, 'none');
  assert.equal(response.tool_choice, 'none');
  assert.equal(response.max_output_tokens, PROGRESS_MAX_OUTPUT_TOKENS);
  assert.ok(PROGRESS_MAX_OUTPUT_TOKENS <= 100);
  assert.deepEqual(response.metadata, { gev: 'progress' });
  assert.equal(response.input[0].content[0].text, line);
  assert.equal(
    response.instructions.includes('Capitol'),
    false,
    'labels never enter instructions',
  );
  assert.equal(
    controller._turns.speakProgressLine('Another line.'),
    false,
    'one line at a time',
  );
});

test('a cancelled progress response never clears a pending Radio handoff', async () => {
  const { controller, sent, event, progressLine, usage } = controllerFixture();
  await progressLine('resp_p');
  // Radio prepared its playback while the line was generating.
  controller.pendingRadioPlaybackResult = {
    ok: true,
    radioPlaybackRequested: true,
  };
  controller.queueResponseCreate('Say "Turning on the radio."');
  controller._turns.retractProgressLine();
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'cancelled',
      metadata: { gev: 'progress' },
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  });
  assert.ok(controller.pendingRadioPlaybackResult, 'Radio stays pending');
  assert.equal(sent.at(-1).type, 'response.create');
  assert.match(
    sent.at(-1).response.instructions,
    /Turning on the radio/,
    'the confirmation is not stranded',
  );
  assert.equal(usage.length, 1, 'progress usage is still billed');
});

test('an old progress completion leaves the active in-band response alone', async () => {
  const { controller, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  // Server VAD starts a real reply while the line is still generating.
  await event({ type: 'response.created', response: { id: 'resp_real' } });
  await event({
    type: 'response.output_audio_transcript.done',
    response_id: 'resp_p',
    transcript: 'Heading to Austin.',
  });
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'completed',
      metadata: { gev: 'progress' },
    },
  });
  assert.equal(controller.activeResponseId, 'resp_real');
  assert.equal(controller.responseActive, true);
});

test('user speech stops an audible progress line: cancel and clear its audio', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  sent.length = 0;
  await event({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual(types(sent), [
    'response.cancel',
    'output_audio_buffer.clear',
  ]);
  assert.equal(sent[0].response_id, 'resp_p');
});

test('a typed command stops an audible progress line too', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'completed',
      metadata: { gev: 'progress' },
    },
  });
  sent.length = 0;
  controller.sendTextCommand('go to Paris');
  assert.equal(
    types(sent)[0],
    'output_audio_buffer.clear',
    'playback still owned after generation ended',
  );
});

test('a finished tool lets a heard line finish, and playback ownership outlives response.done', async () => {
  const { controller, sent, event, progressLine } = controllerFixture();
  await progressLine('resp_p');
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_p' });
  controller._turns.retractProgressLine();
  assert.equal(
    types(sent).includes('response.cancel'),
    false,
    'audible lines are not cut',
  );
  controller.queueResponseCreate('Speak the say line.');
  assert.equal(
    types(sent).filter((t) => t === 'response.create').length,
    1,
    'follow-up waits for generation',
  );
  await event({
    type: 'response.done',
    response: {
      id: 'resp_p',
      status: 'completed',
      metadata: { gev: 'progress' },
    },
  });
  assert.equal(
    types(sent).filter((t) => t === 'response.create').length,
    2,
    'follow-up after the line',
  );
  assert.equal(
    controller._turns.canNarrate(),
    false,
    'still playing: no new line',
  );
  await event({ type: 'output_audio_buffer.stopped', response_id: 'resp_p' });
  assert.equal(controller._turns.progressResponse, null);
});

test('an unheard line is cancelled when its tool finishes', async () => {
  const { controller, sent, progressLine } = controllerFixture();
  await progressLine('resp_p');
  controller._turns.retractProgressLine();
  assert.equal(sent.at(-1).type, 'response.cancel');
  assert.equal(sent.at(-1).response_id, 'resp_p');
});

test('Radio handoff phases block barge-in and narration: prepared, reserved and starting playback', async () => {
  const { controller, sent, event } = controllerFixture();
  await event({ type: 'response.created', response: { id: 'resp_r' } });
  await event({
    type: 'response.done',
    response: { id: 'resp_r', status: 'completed' },
  });
  await event({ type: 'output_audio_buffer.started', response_id: 'resp_r' });
  const radio = controller._radio;
  const phases = [
    () => {
      radio.pendingRadioPlaybackResult = { ok: true };
    },
    () => {
      radio.radioVisibilityOffPending = true;
    },
    () => {
      radio.radioHandoffInFlight = true;
    },
  ];
  for (const enter of phases) {
    radio.pendingRadioPlaybackResult = null;
    radio.radioVisibilityOffPending = false;
    radio.radioHandoffInFlight = false;
    enter();
    assert.equal(radio.mayVoiceClaimSpeaker(), false);
    assert.equal(controller._turns.bargeIn(), false);
    assert.equal(controller._turns.canNarrate(), false);
  }
  assert.deepEqual(sent, []);
});

test('caption transcription is metered with the served transcription model', async () => {
  const { controller, event } = controllerFixture();
  controller._cost.bindTranscriptionModel('gpt-4o-mini-transcribe');
  const before = controller.costTracker.state().totalUsd;
  await event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_u',
    transcript: 'take me to Tokyo',
    usage: {
      type: 'tokens',
      input_tokens: 1000,
      input_token_details: { audio_tokens: 1000 },
      output_tokens: 10,
    },
  });
  const after = controller.costTracker.state().totalUsd;
  assert.ok(Math.abs(after - before - (1000 * 3 + 10 * 5) / 1_000_000) < 1e-12);
});

test('tools report start, progress and finish to narration; Radio stays silent', async () => {
  const calls = [];
  const { controller, event } = controllerFixture({
    runner: async (name, args, options) => {
      options.progress?.({ step: 'resolve', label: 'Zilker Park' });
      return { ok: true, action: name };
    },
  });
  controller._turns.narration = {
    toolStarted: (id, info) =>
      calls.push(['start', id, info.name, info.narrate, info.label]),
    progress: (id, update) => calls.push(['progress', id, update.step]),
    toolFinished: (id) => calls.push(['finish', id]),
    preamble: () => calls.push(['preamble']),
    userTurnEnded() {},
    cancel() {},
    audible() {},
    quiet() {},
  };
  await event({
    type: 'response.output_audio_transcript.delta',
    response_id: 'resp_t',
    delta: 'Finding ',
  });
  await event({
    type: 'response.function_call_arguments.done',
    response_id: 'resp_t',
    call_id: 'call_1',
    name: 'annotate_map',
    arguments: JSON.stringify({ annotations: [{ target: 'Zilker Park' }] }),
  });
  assert.deepEqual(calls, [
    ['preamble'],
    ['start', 'call_1', 'annotate_map', true, 'Zilker Park'],
    ['progress', 'call_1', 'resolve'],
    ['finish', 'call_1'],
  ]);
  calls.length = 0;
  await event({
    type: 'response.function_call_arguments.done',
    response_id: 'resp_r',
    call_id: 'call_2',
    name: 'control_radio',
    arguments: JSON.stringify({ action: 'volume', volumePct: 20 }),
  });
  assert.equal(calls.find((call) => call[0] === 'start')?.[3], false);
});

test('OpenAI dispatch binds first-party input across a tool follow-up and retires it at final generation', async () => {
  const observed = [];
  const calls = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
    runner: async (name, _args, options) => {
      calls.push({
        name,
        options,
        text: readVoiceUserTurnText(options.userTurn),
      });
      return {
        ok: true,
        action: name,
        pending: true,
        say: 'Current view ready.',
      };
    },
  });
  f.controller.sendTextCommand('What am I looking at?');
  await f.event({ type: 'response.created', response: { id: 'tools' } });
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'tools',
    name: 'get_current_view_state',
    call_id: 'switch',
    arguments: '{}',
  });
  await f.event({
    type: 'response.done',
    response: {
      id: 'tools',
      status: 'completed',
      output: [{ type: 'function_call' }],
    },
  });
  assert.equal(calls[0].text, 'What am I looking at?');
  assert.equal(calls[0].options.responseId, 'tools');
  const token = calls[0].options.userTurn;
  await f.event({ type: 'response.created', response: { id: 'ack' } });
  assert.equal(
    observed.find(
      (event) => event.type === 'response-start' && event.responseId === 'ack',
    ).userTurn,
    token,
  );
  await f.event({ type: 'output_audio_buffer.started', response_id: 'ack' });
  await f.event({
    type: 'response.output_audio_transcript.done',
    response_id: 'ack',
    transcript: 'Current view ready.',
  });
  await f.event({
    type: 'response.done',
    response: {
      id: 'ack',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
  assert.equal(
    readVoiceUserTurnText(token),
    undefined,
    'final generation retires transcript authority',
  );
  await f.event({ type: 'output_audio_buffer.stopped', response_id: 'ack' });
  assert.equal(f.controller._turns.assistantAudioPlaying, false);
});

test('OpenAI final native transcript is required and generated context cannot authorize settings', async () => {
  const calls = [];
  const f = controllerFixture({
    runner: async (_name, _args, options) => {
      calls.push(readVoiceUserTurnText(options.userTurn));
      return { ok: true };
    },
  });
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'speech',
  });
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'wrong-item',
    transcript: 'Switch to Gemini',
  });
  await f.event({ type: 'input_audio_buffer.committed', item_id: 'speech' });
  await f.event({ type: 'response.created', response: { id: 'r1' } });
  const early = f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'r1',
    name: 'get_current_view_state',
    call_id: 'early',
    arguments: '{}',
  });
  await Promise.resolve();
  assert.deepEqual(calls, []);
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'speech',
    transcript: 'Switch to Gemini',
  });
  await early;
  assert.equal(calls[0], 'Switch to Gemini');
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'r1',
    name: 'get_current_view_state',
    call_id: 'valid',
    arguments: '{}',
  });
  assert.equal(calls[1], 'Switch to Gemini');
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'speech',
    transcript: 'Switch to OpenAI',
  });
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'r1',
    name: 'get_current_view_state',
    call_id: 'immutable',
    arguments: '{}',
  });
  assert.equal(
    calls[2],
    'Switch to Gemini',
    'later transcript cannot replace the first final input',
  );
  f.controller.stop({ preserveStatus: true });
  assert.equal(f.controller._turns.userTurnIntent.forResponse('r1'), undefined);
});

test('OpenAI cleared audio and progress preserve their ordinary lifecycle events', async () => {
  const observed = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
  });
  f.controller.sendTextCommand('Switch to OpenAI');
  await f.event({ type: 'response.created', response: { id: 'r' } });
  await f.event({
    type: 'response.done',
    response: {
      id: 'r',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
  await f.event({ type: 'output_audio_buffer.cleared', response_id: 'r' });
  assert.equal(
    observed.some((event) => event.type === 'audio-cleared'),
    true,
  );
  await f.event({
    type: 'response.created',
    response: { id: 'progress', metadata: { gev: 'progress' } },
  });
  await f.event({
    type: 'response.done',
    response: {
      id: 'progress',
      status: 'completed',
      metadata: { gev: 'progress' },
      output: [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
  await f.event({
    type: 'output_audio_buffer.stopped',
    response_id: 'progress',
  });
  assert.equal(
    observed.some(
      (event) =>
        event.type === 'response-start' && event.responseId === 'progress',
    ),
    false,
  );
});

test('OpenAI clears stale speech before a typed provider request reaches the model', async () => {
  const f = controllerFixture();
  await f.event({ type: 'response.created', response: { id: 'old' } });
  await f.event({ type: 'output_audio_buffer.started', response_id: 'old' });

  f.controller.sendTextCommand('Switch providers to Gemini');

  assert.deepEqual(
    f.sent
      .filter((message) =>
        [
          'response.cancel',
          'output_audio_buffer.clear',
          'conversation.item.create',
        ].includes(message.type),
      )
      .map((message) => message.type),
    [
      'response.cancel',
      'output_audio_buffer.clear',
      'conversation.item.create',
    ],
  );
  assert.equal(
    f.sent.find((message) => message.type === 'response.cancel').response_id,
    'old',
  );
});

test('OpenAI emits first-party final input and locally retires competing model output', async () => {
  const observed = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
  });
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'speech',
  });
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'speech',
    transcript: 'Switch to Gemini',
  });
  assert.deepEqual(
    observed.findLast((event) => event.type === 'user-input-final'),
    {
      type: 'user-input-final',
      inputKind: 'speech',
      inputId: 'speech',
      inputScope: 'utterance',
      text: 'Switch to Gemini',
    },
  );
  const finalCount = observed.filter(
    (event) => event.type === 'user-input-final',
  ).length;
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'stale-speech',
    transcript: 'Switch to OpenAI',
  });
  await f.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'speech',
    transcript: 'Switch to OpenAI',
  });
  assert.equal(
    observed.filter((event) => event.type === 'user-input-final').length,
    finalCount,
  );
  await f.event({ type: 'response.created', response: { id: 'r1' } });
  await f.event({ type: 'output_audio_buffer.started', response_id: 'r1' });
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  assert.deepEqual(types(f.sent).slice(-2), [
    'response.cancel',
    'output_audio_buffer.clear',
  ]);
  await f.event({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  assert.equal(
    observed.findLast((event) => event.type === 'audio-cleared').reason,
    'local-provider-guidance',
  );
});

test('OpenAI preserves FIFO local clear provenance across release and reclaim', async () => {
  const observed = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
  });
  await f.event({ type: 'response.created', response: { id: 'old' } });
  await f.event({ type: 'output_audio_buffer.started', response_id: 'old' });
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  f.controller.releaseLocalProviderCommand();
  await f.event({ type: 'response.created', response: { id: 'new' } });
  await f.event({ type: 'output_audio_buffer.started', response_id: 'new' });
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  await f.event({
    type: 'output_audio_buffer.cleared',
    response_id: 'old',
  });
  await f.event({
    type: 'output_audio_buffer.cleared',
    response_id: 'new',
  });
  assert.deepEqual(
    observed
      .filter((event) => event.type === 'audio-cleared')
      .slice(-2)
      .map((event) => event.reason),
    ['local-provider-guidance', 'local-provider-guidance'],
  );
});

test('OpenAI local output mutes remote audio immediately and restores its prior state', () => {
  const f = controllerFixture();
  const speakers = [];
  f.controller.audioEl = { muted: false };
  f.controller.setVoiceSpeaker = (...args) => speakers.push(args);
  assert.equal(f.controller.beginLocalOutput(), true);
  assert.equal(f.controller.audioEl.muted, true);
  assert.deepEqual(speakers, [['ai']]);
  f.controller.endLocalOutput();
  assert.equal(f.controller.audioEl.muted, false);
  assert.deepEqual(speakers, [
    ['ai'],
    ['idle', { keepVisualizerSpeaker: true }],
  ]);

  f.controller.audioEl.muted = true;
  assert.equal(f.controller.beginLocalOutput(), true);
  f.controller.endLocalOutput();
  assert.equal(f.controller.audioEl.muted, true);
});

test('OpenAI local output gates the physical microphone but preserves the latest request', () => {
  const f = controllerFixture();
  const track = { enabled: true };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  f.controller.status = 'listening';
  f.controller.stream = stream;

  f.controller.setMicrophoneEnabled(true);
  assert.equal(f.controller.beginLocalOutput(), true);
  assert.equal(track.enabled, false, 'local speech physically mutes open mic');
  f.controller.setMicrophoneEnabled(false);
  f.controller.setMicrophoneEnabled(true);
  assert.equal(track.enabled, false, 'requests cannot bypass local output');
  assert.equal(f.controller.endLocalOutput(), true);
  assert.equal(
    track.enabled,
    true,
    'the latest live-session request is restored',
  );

  assert.equal(f.controller.beginLocalOutput(), true);
  f.controller.setMicrophoneEnabled(false);
  f.controller.endLocalOutput();
  assert.equal(track.enabled, false, 'a PTT release during output stays muted');
});

test('OpenAI ignores delayed speech-start VAD while local output owns the speaker', async () => {
  const observed = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
  });
  let narrationCancels = 0;
  f.controller._turns.narration = {
    cancel: () => narrationCancels++,
  };
  assert.equal(f.controller.beginLocalOutput(), true);
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'echo',
  });
  assert.equal(f.controller.userTurnPending, false);
  assert.equal(narrationCancels, 0);
  assert.equal(
    observed.some(
      (event) =>
        event.type === 'user-turn-start' || event.type === 'interruption',
    ),
    false,
  );

  f.controller.endLocalOutput();
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'real-user',
  });
  assert.equal(f.controller.userTurnPending, true);
  assert.equal(narrationCancels, 1);
  assert.equal(
    observed.some((event) => event.type === 'user-turn-start'),
    true,
  );
});

test('OpenAI Stop prevents late local-output cleanup from reviving the mic', () => {
  const f = controllerFixture();
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  f.controller.status = 'listening';
  f.controller.stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  f.controller.setMicrophoneEnabled(true);
  assert.equal(f.controller.beginLocalOutput(), true);
  f.controller.stop();
  assert.equal(track.stopped, true);
  assert.equal(f.controller.endLocalOutput(), false);
  assert.equal(track.enabled, false);
});

test('OpenAI reset clears provider ownership and stale clear attribution', async () => {
  const observed = [];
  const f = controllerFixture({
    onSessionEvent: (event) => observed.push(event),
  });
  await f.event({ type: 'response.created', response: { id: 'old' } });
  await f.event({ type: 'output_audio_buffer.started', response_id: 'old' });
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  f.controller._turns.reset();
  await f.event({ type: 'output_audio_buffer.cleared', response_id: 'old' });
  const cleared = observed.findLast((event) => event.type === 'audio-cleared');
  assert.equal(Object.hasOwn(cleared, 'reason'), false);
  assert.equal(f.controller._turns.localProviderCommandClaimed, false);
});

test('OpenAI retires a late provider response after release without suppressing an interleaved fresh turn', async () => {
  const calls = [];
  const f = controllerFixture({
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'provider-input',
  });
  await f.event({
    type: 'input_audio_buffer.committed',
    item_id: 'provider-input',
  });
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  f.controller.releaseLocalProviderCommand();
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'fresh-input',
  });
  await f.event({
    type: 'input_audio_buffer.committed',
    item_id: 'fresh-input',
  });
  await f.event({ type: 'response.created', response: { id: 'late' } });
  assert.equal(
    f.sent.filter((message) => message.type === 'response.cancel').length,
    1,
  );
  assert.equal(
    f.sent.findLast((message) => message.type === 'response.cancel')
      .response_id,
    'late',
  );
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'late',
    call_id: 'late-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  assert.deepEqual(calls, []);
  await f.event({ type: 'response.created', response: { id: 'fresh' } });
  assert.equal(
    f.sent.filter((message) => message.type === 'response.cancel').length,
    1,
  );
});

test('an unrelated Realtime error cannot erase a retired provider response', async () => {
  const calls = [];
  const f = controllerFixture({
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  await f.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'provider-input',
  });
  await f.event({
    type: 'input_audio_buffer.committed',
    item_id: 'provider-input',
  });
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  f.controller.releaseLocalProviderCommand();
  await f.event({
    type: 'error',
    event_id: 'server-error',
    error: { code: 'server_error', message: 'unrelated' },
  });
  await f.event({ type: 'response.created', response: { id: 'late' } });
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'late',
    call_id: 'late-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  assert.equal(
    f.sent.findLast((message) => message.type === 'response.cancel')
      ?.response_id,
    'late',
  );
  assert.deepEqual(calls, []);
});

test('OpenAI cancels a stale response reservation and keeps its successor current', async () => {
  const calls = [];
  const f = controllerFixture({
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  f.controller.sendTextCommand('old turn');
  f.controller.sendTextCommand('fresh turn');
  await f.event({ type: 'response.created', response: { id: 'stale' } });
  assert.equal(
    f.sent.findLast((message) => message.type === 'response.cancel')
      ?.response_id,
    'stale',
  );
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'stale',
    call_id: 'stale-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  assert.deepEqual(calls, []);
  await f.event({
    type: 'response.done',
    response: { id: 'stale', status: 'cancelled' },
  });
  await f.event({ type: 'response.created', response: { id: 'fresh' } });
  await f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'fresh',
    call_id: 'fresh-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  assert.deepEqual(calls, ['get_current_view_state']);
});

test('OpenAI local provider ownership aborts an already-running tool', async () => {
  let toolSignal;
  const f = controllerFixture({
    runner: async (_name, _args, options) => {
      toolSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('Provider command claimed output');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    },
  });
  await f.event({
    type: 'response.created',
    response: { id: 'tool-response' },
  });
  const pending = f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'tool-response',
    call_id: 'tool-call',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  for (let index = 0; index < 3 && !toolSignal; index++)
    await Promise.resolve();
  assert.ok(toolSignal);
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  assert.equal(toolSignal.aborted, true);
  await pending;
  const output = f.sent.find(
    (message) =>
      message.type === 'conversation.item.create' &&
      message.item?.type === 'function_call_output' &&
      message.item.call_id === 'tool-call',
  );
  assert.ok(output);
  assert.deepEqual(JSON.parse(output.item.output), {
    ok: false,
    error: 'Superseded by a local provider command',
    tool: 'get_current_view_state',
    action: 'get_current_view_state',
    cancelled: true,
    superseded: true,
  });
  assert.equal(
    f.sent.some((message) => message.type === 'response.create'),
    false,
  );
});

test('OpenAI provider ownership settles a cancelled Radio tool silently', async () => {
  let toolSignal;
  let resolveTool;
  const f = controllerFixture({
    runner: async (_name, _args, options) => {
      toolSignal = options.signal;
      return new Promise((resolve) => {
        resolveTool = resolve;
      });
    },
  });
  await f.event({
    type: 'response.created',
    response: { id: 'radio-response' },
  });
  const pending = f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'radio-response',
    call_id: 'radio-tool-call',
    name: 'control_radio',
    arguments: '{"action":"select"}',
  });
  for (let index = 0; index < 3 && !toolSignal; index++)
    await Promise.resolve();
  assert.ok(toolSignal);
  assert.equal(f.controller.claimLocalProviderCommand(), true);
  assert.equal(toolSignal.aborted, true);
  resolveTool({
    ok: true,
    station: 'stale station',
    enabled: true,
    audioState: 'playing',
    radioPlaybackRequested: true,
  });
  await pending;
  const output = f.sent.find(
    (message) =>
      message.type === 'conversation.item.create' &&
      message.item?.type === 'function_call_output' &&
      message.item.call_id === 'radio-tool-call',
  );
  assert.ok(output);
  const result = JSON.parse(output.item.output);
  assert.equal(result.cancelled, true);
  assert.equal(result.radioPlaybackRequested, false);
  assert.equal(result.enabled, false);
  assert.equal(result.audioState, 'stopped');
  assert.equal('station' in result, false);
  assert.equal(
    f.sent.some((message) => message.type === 'response.create'),
    false,
  );
});

test('OpenAI cancellation never publishes a stale resolved tool payload', async () => {
  let toolSignal;
  let resolveTool;
  const f = controllerFixture({
    runner: async (_name, _args, options) => {
      toolSignal = options.signal;
      return new Promise((resolve) => {
        resolveTool = resolve;
      });
    },
  });
  await f.event({ type: 'response.created', response: { id: 'old' } });
  const pending = f.event({
    type: 'response.function_call_arguments.done',
    response_id: 'old',
    call_id: 'old-tool',
    name: 'get_current_view_state',
    arguments: '{}',
  });
  for (let index = 0; index < 3 && !toolSignal; index++)
    await Promise.resolve();
  assert.ok(toolSignal);
  f.controller.sendTextCommand('fresh turn');
  assert.equal(toolSignal.aborted, true);
  resolveTool({ ok: true, say: 'stale speech', data: { sentinel: 'stale' } });
  await pending;
  const output = f.sent.find(
    (message) =>
      message.type === 'conversation.item.create' &&
      message.item?.type === 'function_call_output' &&
      message.item.call_id === 'old-tool',
  );
  assert.ok(output);
  const result = JSON.parse(output.item.output);
  assert.equal(result.cancelled, true);
  assert.equal(result.superseded, true);
  assert.equal('say' in result, false);
  assert.equal('data' in result, false);
});

for (const [label, cancel] of [
  [
    'typed input',
    (fixture) => fixture.controller.sendTextCommand('fresh turn'),
  ],
  [
    'speech onset',
    (fixture) =>
      fixture.event({
        type: 'input_audio_buffer.speech_started',
        item_id: 'fresh-speech',
      }),
  ],
]) {
  test(`OpenAI ${label} cannot publish an aborted tool failure`, async () => {
    let toolSignal;
    const f = controllerFixture({
      runner: async (_name, _args, options) => {
        toolSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              const error = new Error('New user turn');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    });
    await f.event({ type: 'response.created', response: { id: 'old' } });
    const pending = f.event({
      type: 'response.function_call_arguments.done',
      response_id: 'old',
      call_id: 'old-tool',
      name: 'get_current_view_state',
      arguments: '{}',
    });
    for (let index = 0; index < 3 && !toolSignal; index++)
      await Promise.resolve();
    assert.ok(toolSignal);
    f.sent.length = 0;
    await cancel(f);
    assert.equal(toolSignal.aborted, true);
    await pending;
    const output = f.sent.find(
      (message) =>
        message.type === 'conversation.item.create' &&
        message.item?.type === 'function_call_output' &&
        message.item.call_id === 'old-tool',
    );
    assert.ok(output);
    assert.equal(JSON.parse(output.item.output).cancelled, true);
    assert.equal(JSON.parse(output.item.output).superseded, true);
    assert.equal(
      f.sent.some((message) => message.type === 'response.create'),
      false,
    );
  });
}
