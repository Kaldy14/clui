import { useEffect, useCallback } from "react";

import { getAppSettingsSnapshot } from "../appSettings";
import { useAudioCapture } from "./useAudioCapture";
import whisperManager from "../lib/whisperManager";
import { readNativeApi } from "../nativeApi";
import { useSpeechStore } from "../speechStore";

interface UseSpeechToTextReturn {
  startRecording: () => void;
  stopRecording: () => void;
  toggle: () => void;
}

export function useSpeechToText(threadId: string): UseSpeechToTextReturn {
  const { startRecording: startAudio, stopRecording: stopAudio, audioLevel } = useAudioCapture();
  const setAudioLevel = useSpeechStore((s) => s.setAudioLevel);
  const setStatus = useSpeechStore((s) => s.setStatus);
  const setError = useSpeechStore((s) => s.setError);
  const setActiveThreadId = useSpeechStore((s) => s.setActiveThreadId);

  // Forward audioLevel into the store
  useEffect(() => {
    setAudioLevel(audioLevel);
  }, [audioLevel, setAudioLevel]);

  const startRecording = useCallback(() => {
    const store = useSpeechStore.getState();
    if (store.status !== "idle") return;

    if (!whisperManager.isModelReady()) {
      setStatus("notInstalled");
      return;
    }

    void (async () => {
      try {
        await startAudio();
        setStatus("recording");
        setActiveThreadId(threadId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("idle");
      }
    })();
  }, [startAudio, setStatus, setError, setActiveThreadId, threadId]);

  const stopRecording = useCallback(() => {
    const store = useSpeechStore.getState();
    if (store.status !== "recording") return;

    void (async () => {
      try {
        const audio = await stopAudio();
        setStatus("transcribing");
        const settings = getAppSettingsSnapshot();
        const rawText = await whisperManager.transcribe(audio, settings.whisperLanguage ?? "en");
        const trimmed = rawText.trim();
        if (!trimmed) {
          setStatus("idle");
          setActiveThreadId(null);
          return;
        }
        const prefix = settings.voicePrefix?.trim();
        const data = prefix ? `${prefix} ${trimmed}\n` : `${trimmed}\n`;
        readNativeApi()?.claude.write({ threadId, data });
        setStatus("idle");
        setActiveThreadId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("idle");
        setActiveThreadId(null);
      }
    })();
  }, [stopAudio, setStatus, setError, setActiveThreadId, threadId]);

  const toggle = useCallback(() => {
    const store = useSpeechStore.getState();
    if (store.status === "idle") {
      startRecording();
    } else if (store.status === "recording") {
      stopRecording();
    }
  }, [startRecording, stopRecording]);

  // Listen for keyboard shortcut toggle events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId: string }>).detail;
      if (detail.threadId !== threadId) return;
      toggle();
    };
    window.addEventListener("clui:speech-toggle", handler);
    return () => window.removeEventListener("clui:speech-toggle", handler);
  }, [threadId, toggle]);

  return { startRecording, stopRecording, toggle };
}
