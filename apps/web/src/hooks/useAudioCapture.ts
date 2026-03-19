import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16_000;

export interface UseAudioCaptureReturn {
  isRecording: boolean;
  audioLevel: number;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Float32Array>;
  error: string | null;
}

/**
 * Linearly interpolate to resample from `inputRate` to `outputRate`.
 * This avoids the unreliable AudioContext/OfflineAudioContext resampling path.
 */
function resamplePCM(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    output[i] = input[lo]! * (1 - frac) + input[hi]! * frac;
  }
  return output;
}

export function useAudioCapture(): UseAudioCaptureReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const stopResolveRef = useRef<((audio: Float32Array) => void) | null>(null);
  const stoppedRef = useRef(false);

  const stopLevelLoop = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, []);

  const startLevelLoop = useCallback((analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i]!;
      }
      const avg = sum / data.length / 255;
      setAudioLevel(avg);
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const cleanup = useCallback(() => {
    stopLevelLoop();
    setAudioLevel(0);

    // Disconnect processor and source
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;

    // Stop media tracks
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    // Close AudioContext
    if (audioContextRef.current?.state !== "closed") {
      void audioContextRef.current?.close();
    }
    audioContextRef.current = null;
    analyserRef.current = null;
  }, [stopLevelLoop]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Audio capture is not supported in this browser.");
      return;
    }

    setError(null);

    try {
      // Request mono audio at the system's native sample rate.
      // Do NOT request sampleRate: 16000 — browsers ignore it and it can
      // cause getUserMedia to fail on some devices.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // AudioContext will run at the system's native sample rate (44.1k or 48k)
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Set up analyser for audio level visualization
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Capture raw PCM via ScriptProcessorNode.
      // This gives us Float32Array chunks at the native sample rate —
      // no MediaRecorder encoding/decoding roundtrip needed.
      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      chunksRef.current = [];
      stoppedRef.current = false;

      processor.onaudioprocess = (e) => {
        if (stoppedRef.current) return;
        // Copy the input data — the buffer is reused by the audio system
        const input = e.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(input));
      };

      source.connect(processor);
      // ScriptProcessorNode must be connected to destination to receive events
      processor.connect(audioCtx.destination);
      processorRef.current = processor;

      startLevelLoop(analyser);
      setIsRecording(true);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to start recording";
      setError(msg);
    }
  }, [startLevelLoop, stopLevelLoop]);

  const stopRecording = useCallback((): Promise<Float32Array> => {
    return new Promise<Float32Array>((resolve, reject) => {
      const audioCtx = audioContextRef.current;
      if (!audioCtx || stoppedRef.current) {
        reject(new Error("Not recording"));
        return;
      }

      stoppedRef.current = true;
      setIsRecording(false);

      const nativeSampleRate = audioCtx.sampleRate;
      const chunks = chunksRef.current;
      chunksRef.current = [];

      // Concatenate all PCM chunks into a single buffer
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      if (totalLength === 0) {
        cleanup();
        reject(new Error("No audio data captured"));
        return;
      }

      const raw = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.length;
      }

      // Resample from native rate (44.1k/48k) to 16kHz for Whisper
      const resampled = resamplePCM(raw, nativeSampleRate, TARGET_SAMPLE_RATE);

      cleanup();
      resolve(resampled);
    });
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      cleanup();
    };
  }, [cleanup]);

  return { isRecording, audioLevel, startRecording, stopRecording, error };
}
