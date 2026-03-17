import { useEffect } from "react";

import { getAppSettingsSnapshot } from "../appSettings";
import { useAudioCapture } from "./useAudioCapture";
import whisperManager from "../lib/whisperManager";
import { readNativeApi } from "../nativeApi";
import { useSpeechStore } from "../speechStore";

export function useSpeechToText(threadId: string): { toggle: () => void } {
  const { startRecording, stopRecording, audioLevel } = useAudioCapture();
  const setAudioLevel = useSpeechStore((s) => s.setAudioLevel);
  const setStatus = useSpeechStore((s) => s.setStatus);
  const setError = useSpeechStore((s) => s.setError);
  const setActiveThreadId = useSpeechStore((s) => s.setActiveThreadId);

  // Forward audioLevel into the store
  useEffect(() => {
    setAudioLevel(audioLevel);
  }, [audioLevel, setAudioLevel]);

  const toggle = () => {
    const store = useSpeechStore.getState();
    const status = store.status;

    if (status === "idle") {
      if (!whisperManager.isModelReady()) {
        setStatus("notInstalled");
        return;
      }
      void (async () => {
        try {
          await startRecording();
          setStatus("recording");
          setActiveThreadId(threadId);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("idle");
        }
      })();
    } else if (status === "recording") {
      void (async () => {
        try {
          const audio = await stopRecording();
          setStatus("transcribing");
          const settings = getAppSettingsSnapshot();
          const text = await whisperManager.transcribe(audio, settings.whisperLanguage ?? "en");
          readNativeApi()?.claude.write({ threadId, data: text });
          setStatus("idle");
          setActiveThreadId(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("idle");
          setActiveThreadId(null);
        }
      })();
    }
  };

  return { toggle };
}
