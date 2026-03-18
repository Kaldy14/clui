import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioCaptureReturn {
  isRecording: boolean;
  audioLevel: number;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Float32Array>;
  error: string | null;
}

export function useAudioCapture(): UseAudioCaptureReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const stopResolveRef = useRef<((audio: Float32Array) => void) | null>(null);
  const stopRejectRef = useRef<((err: Error) => void) | null>(null);

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

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Audio capture is not supported in this browser.");
      return;
    }

    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      streamRef.current = stream;

      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stopLevelLoop();
        setAudioLevel(0);

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

        try {
          const arrayBuffer = await blob.arrayBuffer();
          // Decode using an OfflineAudioContext to resample to 16kHz mono
          const tmpCtx = new AudioContext({ sampleRate: 16000 });
          const decoded = await tmpCtx.decodeAudioData(arrayBuffer);
          await tmpCtx.close();

          // Mix down to mono
          const mono = new Float32Array(decoded.length);
          for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            const channelData = decoded.getChannelData(ch);
            for (let i = 0; i < channelData.length; i++) {
              mono[i] = (mono[i] ?? 0) + (channelData[i] ?? 0);
            }
          }
          if (decoded.numberOfChannels > 1) {
            for (let i = 0; i < mono.length; i++) {
              mono[i] = (mono[i] ?? 0) / decoded.numberOfChannels;
            }
          }

          stopResolveRef.current?.(mono);
        } catch (err) {
          stopRejectRef.current?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        } finally {
          stopResolveRef.current = null;
          stopRejectRef.current = null;
          // Cleanup stream tracks
          stream.getTracks().forEach((t) => t.stop());
          if (audioCtx.state !== "closed") {
            await audioCtx.close();
          }
          audioContextRef.current = null;
          analyserRef.current = null;
          streamRef.current = null;
          mediaRecorderRef.current = null;
        }
      };

      recorder.start();
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
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        reject(new Error("Not recording"));
        return;
      }
      stopResolveRef.current = resolve;
      stopRejectRef.current = reject;
      setIsRecording(false);
      recorder.stop();
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopLevelLoop();
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioContextRef.current?.state !== "closed") {
        audioContextRef.current?.close();
      }
    };
  }, [stopLevelLoop]);

  return { isRecording, audioLevel, startRecording, stopRecording, error };
}
