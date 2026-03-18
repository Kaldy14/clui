import { useState, useCallback, useEffect, useRef } from "react";
import { DownloadIcon, Loader2Icon, MicIcon, SettingsIcon, SquareIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { getAppSettingsSnapshot, WHISPER_MODEL_TIERS } from "../appSettings";
import { useSpeechStore } from "../speechStore";
import { useSpeechToText } from "../hooks/useSpeechToText";
import whisperManager from "../lib/whisperManager";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SpeechControl({ threadId }: { threadId: string }) {
  const { startRecording, stopRecording } = useSpeechToText(threadId);
  const status = useSpeechStore((s) => s.status);
  const modelDownloaded = useSpeechStore((s) => s.modelDownloaded);
  const audioLevel = useSpeechStore((s) => s.audioLevel);
  const downloadProgress = useSpeechStore((s) => s.downloadProgress);
  const prefix = getAppSettingsSnapshot().voicePrefix?.trim() || "";

  // On mount, check if the model is already in the browser cache and auto-load it
  const cacheChecked = useRef(false);
  useEffect(() => {
    if (cacheChecked.current || modelDownloaded) return;
    cacheChecked.current = true;

    const tier = getAppSettingsSnapshot().whisperModel ?? "small";
    void whisperManager.isModelCached(tier).then((cached) => {
      if (!cached) return;
      // Model files are in the Cache API — load silently (instant from cache)
      void whisperManager.ensureModel(tier).then(() => {
        useSpeechStore.getState().setModelDownloaded(true);
      });
    });
  }, [modelDownloaded]);

  // Downloading state
  if (status === "downloading") {
    const circumference = Math.PI * 20;
    const dashOffset = circumference * (1 - downloadProgress / 100);
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label="Downloading speech model"
              className="relative size-6 rounded-md p-0 text-muted-foreground/70"
            />
          }
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeOpacity="0.2"
            />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              transform="rotate(-90 10 10)"
            />
            <MicIcon className="absolute inset-0 m-auto size-3" />
          </svg>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Downloading model ({Math.round(downloadProgress)}%)</TooltipPopup>
      </Tooltip>
    );
  }

  // Transcribing state
  if (status === "transcribing") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label="Transcribing"
              className="size-6 rounded-md p-0 text-muted-foreground/70"
            />
          }
        >
          <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Transcribing...</TooltipPopup>
      </Tooltip>
    );
  }

  // Recording state — click stop button to end
  if (status === "recording") {
    const barHeights = [0.4, 0.7, 1.0, 0.7, 0.5];
    const delays = ["0ms", "100ms", "200ms", "150ms", "250ms"];
    return (
      <button
        type="button"
        onClick={stopRecording}
        aria-label="Stop recording"
        className="flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 transition-colors hover:bg-red-500/20"
      >
        <SquareIcon className="size-2.5 fill-red-500 text-red-500" aria-hidden="true" />
        <MicIcon className="size-3 animate-pulse-mic text-red-500" aria-hidden="true" />
        <span className="flex items-end gap-px" aria-hidden="true">
          {barHeights.map((baseHeight, i) => (
            <span
              key={i}
              className="w-0.5 rounded-full bg-red-500"
              style={{
                height: "12px",
                transform: `scaleY(${Math.max(0.2, baseHeight * (0.4 + audioLevel * 0.6))})`,
                transformOrigin: "bottom",
                animationDelay: delays[i],
                transition: "transform 80ms ease-out",
              }}
            />
          ))}
        </span>
        {prefix && (
          <span className="ml-0.5 text-[10px] font-medium text-red-400">{prefix}</span>
        )}
      </button>
    );
  }

  // Not installed (model not downloaded) — show popover with download CTA
  if (!modelDownloaded) {
    return <SpeechDownloadPopover threadId={threadId} />;
  }

  // Idle (model ready) — click to start recording
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            onClick={startRecording}
            aria-label="Start voice input"
            className="size-6 rounded-md p-0 text-muted-foreground/70 hover:text-foreground"
          />
        }
      >
        <MicIcon className="size-3" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {prefix
          ? `Voice input — prefix: "${prefix}" (⌘⇧V)`
          : "Voice input (⌘⇧V)"}
      </TooltipPopup>
    </Tooltip>
  );
}

// ── Download popover shown when no model is installed ────────────────

function SpeechDownloadPopover({ threadId: _threadId }: { threadId: string }) {
  const navigate = useNavigate();
  const [downloading, setDownloading] = useState(false);
  const downloadProgress = useSpeechStore((s) => s.downloadProgress);
  const setDownloadProgress = useSpeechStore((s) => s.setDownloadProgress);
  const setModelDownloaded = useSpeechStore((s) => s.setModelDownloaded);
  const setStatus = useSpeechStore((s) => s.setStatus);

  const selectedTier = getAppSettingsSnapshot().whisperModel ?? "small";
  const tier = WHISPER_MODEL_TIERS.find((t) => t.id === selectedTier) ?? WHISPER_MODEL_TIERS[2];

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setStatus("downloading");
    try {
      await whisperManager.ensureModel(selectedTier, (pct) => {
        setDownloadProgress(pct);
      });
      setModelDownloaded(true);
      setStatus("idle");
    } catch {
      setStatus("idle");
    } finally {
      setDownloading(false);
    }
  }, [selectedTier, setDownloadProgress, setModelDownloaded, setStatus]);

  const handleOpenSettings = useCallback(() => {
    void navigate({ to: "/settings", hash: "speech-to-text" }).then(() => {
      requestAnimationFrame(() => {
        document.getElementById("speech-to-text")?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }, [navigate]);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label="Voice input — setup required"
            className="size-6 rounded-md p-0 text-muted-foreground/70 opacity-60 hover:opacity-100"
          />
        }
      >
        <span className="relative">
          <MicIcon className="size-3" aria-hidden="true" />
          <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
        </span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" sideOffset={8}>
        <div className="flex w-56 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Voice Input</p>
            <p className="text-xs text-muted-foreground">
              Speak to type using a local Whisper model. No data leaves your machine.
            </p>
          </div>

          {downloading ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Downloading {tier.label}...</span>
                <span>{Math.round(downloadProgress)}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void handleDownload()}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
              >
                <DownloadIcon className="size-3.5" />
                Download {tier.label} model ({tier.size})
              </button>
              <button
                type="button"
                onClick={handleOpenSettings}
                className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <SettingsIcon className="size-3" />
                Change model or language
              </button>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
