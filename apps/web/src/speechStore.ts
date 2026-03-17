/**
 * Zustand store for speech-to-text UI state.
 *
 * Ephemeral — no persistence, no middleware.
 * Purely reactive state consumed by the orchestration hook and UI components.
 */

import { create } from "zustand";

type SpeechStatus = "idle" | "notInstalled" | "recording" | "transcribing" | "downloading";

interface SpeechState {
  status: SpeechStatus;
  modelDownloaded: boolean;
  downloadProgress: number; // 0-100
  audioLevel: number; // 0-1
  error: string | null;
  activeThreadId: string | null;

  setStatus: (status: SpeechStatus) => void;
  setModelDownloaded: (downloaded: boolean) => void;
  setDownloadProgress: (pct: number) => void;
  setAudioLevel: (level: number) => void;
  setError: (msg: string | null) => void;
  setActiveThreadId: (threadId: string | null) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  status: "idle" as SpeechStatus,
  modelDownloaded: false,
  downloadProgress: 0,
  audioLevel: 0,
  error: null,
  activeThreadId: null,
};

export const useSpeechStore = create<SpeechState>((set) => ({
  ...INITIAL_STATE,

  setStatus: (status) => set({ status }),
  setModelDownloaded: (downloaded) => set({ modelDownloaded: downloaded }),
  setDownloadProgress: (pct) => set({ downloadProgress: pct }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setError: (msg) => set({ error: msg }),
  setActiveThreadId: (threadId) => set({ activeThreadId: threadId }),
  reset: () => set(INITIAL_STATE),
}));
