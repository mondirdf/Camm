const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_SECONDS = 60;
const MAX_QUEUED_SOURCES = 256;

export function pcmBytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function decodeGeminiPcm(data, mimeType = 'audio/pcm;rate=24000') {
  if (
    typeof data !== 'string' ||
    data.length > 4 * Math.ceil(MAX_AUDIO_BYTES / 3)
  )
    throw new Error('Gemini returned an oversized audio chunk');
  const match = /^audio\/pcm(?:;rate=(\d+))?$/.exec(mimeType);
  if (!match) throw new Error('Gemini returned an unsupported audio format');
  const sampleRate = Number(match[1] || 24000);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
    throw new Error('Gemini returned an invalid audio sample rate');
  const binary = atob(data);
  if (binary.length > MAX_AUDIO_BYTES)
    throw new Error('Gemini returned an oversized audio chunk');
  if (!binary.length || binary.length % 2)
    throw new Error('Gemini returned incomplete PCM audio');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 32768;
  return { samples, sampleRate };
}

/** Own capture and playback independently from the Live protocol. */
export function createGeminiAudio({
  onAudioStart,
  onAudio,
  onAudioEnd,
  onDrain,
  onError,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeClass = globalThis.AudioWorkletNode,
} = {}) {
  if (!AudioContextClass || !AudioWorkletNodeClass)
    throw new Error('This browser does not support Gemini microphone audio');
  let captureContext;
  let playbackContext;
  let output;
  let meter;
  let resumed;
  const closeContext = (context) => {
    try {
      return Promise.resolve(context?.close());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  try {
    // Capture at the device rate; the worklet explicitly resamples to 16 kHz.
    captureContext = new AudioContextClass();
    playbackContext = new AudioContextClass({ sampleRate: 24000 });
    // Resume both synchronously within the mic gesture, before any awaits.
    const resume = (context) => {
      try {
        return Promise.resolve(context.resume());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    resumed = Promise.all([resume(captureContext), resume(playbackContext)]);
    // Permission may remain pending before initialize observes this failure.
    void resumed.catch(() => {});
    output = playbackContext.createGain();
    meter = playbackContext.createMediaStreamDestination();
    output.connect(playbackContext.destination);
    output.connect(meter);
  } catch (error) {
    output?.disconnect();
    meter?.disconnect();
    meter?.stream.getTracks?.().forEach((track) => track.stop());
    void Promise.allSettled([
      closeContext(captureContext),
      closeContext(playbackContext),
    ]);
    throw error;
  }
  let closed = false;
  let closeResult;
  let capture = null;
  let microphone = null;
  let mute = null;
  let nextTime = 0;
  let inputChunks = 0;
  let inputPeak = 0;
  let nonSilentInputChunks = 0;
  let outputChunks = 0;
  let outputSamples = 0;
  let completedOutputSamples = 0;
  let discardedOutputSamples = 0;
  const sources = new Map();

  function clearPlayback() {
    const oldSources = [...sources];
    sources.clear();
    nextTime = playbackContext.currentTime;
    for (const [source, sampleCount] of oldSources) {
      discardedOutputSamples += sampleCount;
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
      source.disconnect();
    }
  }

  return {
    outputStream: meter.stream,
    get pending() {
      return sources.size > 0;
    },
    async initialize(signal) {
      try {
        await Promise.all([
          resumed,
          captureContext.audioWorklet.addModule(
            new URL('./geminiCaptureWorklet.js', import.meta.url),
          ),
        ]);
        signal?.throwIfAborted();
        if (closed) throw new DOMException('Voice stopped', 'AbortError');
      } catch (error) {
        await this.close();
        throw error;
      }
    },
    connectMicrophone(stream, enabled, metadata) {
      if (closed) throw new DOMException('Voice stopped', 'AbortError');
      capture = new AudioWorkletNodeClass(
        captureContext,
        'gev-gemini-capture',
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        },
      );
      capture.port.onmessage = ({ data }) => {
        if (closed) return;
        // Capture ownership is transport metadata, never part of Live audio.
        if (!Number.isSafeInteger(data?.captureId) || data.captureId <= 0)
          return;
        const metadata = { captureId: data.captureId };
        try {
          if (data?.type === 'audio' && data.buffer instanceof ArrayBuffer) {
            inputChunks++;
            const pcm = new DataView(data.buffer);
            let peak = 0;
            for (let index = 0; index + 1 < pcm.byteLength; index += 2)
              peak = Math.max(
                peak,
                Math.abs(pcm.getInt16(index, true)) / 32768,
              );
            inputPeak = Math.max(inputPeak, peak);
            if (peak >= 0.01) nonSilentInputChunks++;
            onAudio?.(
              {
                data: pcmBytesToBase64(data.buffer),
                mimeType: 'audio/pcm;rate=16000',
              },
              metadata,
            );
          } else if (data?.type === 'start') onAudioStart?.(metadata);
          else if (data?.type === 'end') onAudioEnd?.(metadata);
        } catch (error) {
          onError?.(error);
        }
      };
      capture.onprocessorerror = () => {
        if (!closed) onError?.(new Error('Microphone audio processing failed'));
      };
      microphone = captureContext.createMediaStreamSource(stream);
      mute = captureContext.createGain();
      mute.gain.value = 0;
      capture.port.postMessage({
        enabled: Boolean(enabled),
        captureId: metadata?.captureId,
      });
      microphone.connect(capture);
      capture.connect(mute);
      mute.connect(captureContext.destination);
    },
    setMicrophoneEnabled(enabled, metadata) {
      if (closed) return;
      capture?.port.postMessage({
        enabled: Boolean(enabled),
        captureId: metadata?.captureId,
      });
    },
    play(data, mimeType) {
      if (closed) return;
      // Tiny chunks can exhaust source nodes long before the duration limit.
      if (sources.size >= MAX_QUEUED_SOURCES)
        throw new Error(
          'Gemini audio playback fell behind. Reconnect to continue.',
        );
      const { samples, sampleRate } = decodeGeminiPcm(data, mimeType);
      const start = Math.max(playbackContext.currentTime + 0.02, nextTime);
      if (
        start + samples.length / sampleRate - playbackContext.currentTime >
        MAX_QUEUED_SECONDS
      )
        throw new Error(
          'Gemini audio playback fell behind. Reconnect to continue.',
        );
      const buffer = playbackContext.createBuffer(
        1,
        samples.length,
        sampleRate,
      );
      buffer.copyToChannel(samples, 0);
      const source = playbackContext.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      sources.set(source, samples.length);
      source.onended = () => {
        if (!sources.delete(source)) return;
        completedOutputSamples += samples.length;
        source.disconnect();
        if (!closed && !sources.size) onDrain?.();
      };
      nextTime = start + buffer.duration;
      outputChunks++;
      outputSamples += samples.length;
      source.start(start);
    },
    clearPlayback,
    diagnostics() {
      return {
        inputChunks,
        inputPeak,
        nonSilentInputChunks,
        outputChunks,
        outputSamples,
        completedOutputSamples,
        discardedOutputSamples,
        queuedSeconds: Math.max(0, nextTime - playbackContext.currentTime),
        contextState:
          captureContext.state === playbackContext.state
            ? captureContext.state
            : 'suspended',
        captureContextState: captureContext.state,
        playbackContextState: playbackContext.state,
        captureSampleRate: captureContext.sampleRate,
        playbackSampleRate: playbackContext.sampleRate,
        inputSampleRate: 16000,
      };
    },
    close() {
      if (closed) return closeResult;
      closed = true;
      clearPlayback();
      if (capture) {
        capture.port.onmessage = null;
        capture.onprocessorerror = null;
        capture.port.close();
        capture.disconnect();
      }
      microphone?.disconnect();
      mute?.disconnect();
      output.disconnect();
      meter.disconnect();
      meter.stream.getTracks?.().forEach((track) => track.stop());
      closeResult = Promise.allSettled([
        closeContext(captureContext),
        closeContext(playbackContext),
      ]).then((results) =>
        results.every((result) => result.status === 'fulfilled'),
      );
      return closeResult;
    },
  };
}
