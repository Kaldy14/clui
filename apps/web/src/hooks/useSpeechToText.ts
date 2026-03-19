import { useEffect, useCallback } from "react";

import { getAppSettingsSnapshot } from "../appSettings";
import { useAudioCapture } from "./useAudioCapture";
import whisperManager from "../lib/whisperManager";
import { readNativeApi } from "../nativeApi";
import { useSpeechStore } from "../speechStore";

// Minimum audio duration in samples at 16kHz.  Anything shorter than ~0.7s
// is almost certainly a key-repeat artefact and will cause Whisper to
// hallucinate phantom phrases ("you", "Thank you", "Thanks for watching").
const MIN_AUDIO_SAMPLES = 16_000 * 0.7;

// Whisper is notorious for outputting these phrases on silence / near-silence.
// Strip them so they don't leak into the terminal.
const WHISPER_HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thank you.",
  "thanks for watching",
  "thanks for watching!",
  "thanks for watching.",
  "subscribe",
  "the end",
  "the end.",
  "bye",
  "bye.",
  "bye bye",
  "bye-bye",
  "...",
  "(silence)",
]);

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
    if (store.status !== "idle" && store.status !== "notInstalled") return;

    if (!whisperManager.isModelReady()) {
      setStatus("notInstalled");
      setError("Speech model not loaded. Download it from the mic button first.");
      return;
    }

    void (async () => {
      try {
        setError(null);
        await startAudio();
        setStatus("recording");
        setActiveThreadId(threadId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isPermission = msg.includes("NotAllowedError") || msg.includes("Permission");
        setError(isPermission ? "Microphone permission denied. Check your browser/system settings." : msg);
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

        // Reject very short recordings — likely key-repeat artefacts
        if (audio.length < MIN_AUDIO_SAMPLES) {
          setStatus("idle");
          setActiveThreadId(null);
          return;
        }

        setStatus("transcribing");
        const settings = getAppSettingsSnapshot();
        const rawText = await whisperManager.transcribe(audio, settings.whisperLanguage ?? "en");
        const trimmed = rawText.trim();

        // Filter Whisper hallucination phrases and empty results
        if (!trimmed || WHISPER_HALLUCINATIONS.has(trimmed.toLowerCase())) {
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
    if (store.status === "idle" || store.status === "notInstalled") {
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
