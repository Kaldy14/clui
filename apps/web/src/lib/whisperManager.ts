/* oxlint-disable unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin */
type WorkerOutMessage =
  | { type: "ready"; id: string }
  | { type: "result"; text: string; id: string }
  | { type: "error"; message: string; id: string }
  | {
      type: "progress";
      progress: { status: string; file?: string; progress?: number };
      id: string;
    };

type WorkerInMessage =
  | { type: "load"; modelId: string; id: string }
  | { type: "transcribe"; audio: Float32Array; language: string; id: string };

const MODEL_IDS: Record<string, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
};

let worker: Worker | null = null;
let loadedModelTier: string | null = null;
let modelReady = false;

/** Idle timeout — terminate the worker if unused for this long. */
const WHISPER_IDLE_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Only terminate if no pending work
    if (pendingTranscribes.size === 0 && !pendingLoad) {
      dispose();
    }
  }, WHISPER_IDLE_TIMEOUT_MS);
}

/**
 * Check if a model's files are already present in the browser Cache API
 * (populated by @huggingface/transformers on prior downloads).
 * Returns true if at least one ONNX file is cached for the model.
 */
async function isModelCached(modelTier: string): Promise<boolean> {
  const modelId = MODEL_IDS[modelTier];
  if (!modelId) return false;

  try {
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    // HF transformers stores files under URLs containing the model ID
    return keys.some((req) => req.url.includes(modelId));
  } catch {
    return false;
  }
}

type PendingLoad = {
  resolve: () => void;
  reject: (err: Error) => void;
  onProgress: ((pct: number) => void) | undefined;
};

type PendingTranscribe = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

let pendingLoad: PendingLoad | null = null;
const pendingTranscribes = new Map<string, PendingTranscribe>();

let msgIdCounter = 0;
function nextId(): string {
  return String(++msgIdCounter);
}

function getOrCreateWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(
    new URL("../workers/whisperWorker.ts", import.meta.url),
    { type: "module" },
  );

  worker.addEventListener("message", (event: MessageEvent<WorkerOutMessage>) => {
    const msg = event.data;

    if (msg.type === "ready") {
      modelReady = true;
      pendingLoad?.resolve();
      pendingLoad = null;
      resetIdleTimer();
      return;
    }

    if (msg.type === "progress") {
      if (
        pendingLoad?.onProgress !== undefined &&
        typeof msg.progress.progress === "number"
      ) {
        pendingLoad.onProgress(msg.progress.progress);
      }
      return;
    }

    if (msg.type === "result") {
      const pending = pendingTranscribes.get(msg.id);
      if (pending) {
        pendingTranscribes.delete(msg.id);
        pending.resolve(msg.text);
      }
      resetIdleTimer();
      return;
    }

    if (msg.type === "error") {
      if (pendingLoad) {
        const load = pendingLoad;
        pendingLoad = null;
        load.reject(new Error(msg.message));
        return;
      }
      const pending = pendingTranscribes.get(msg.id);
      if (pending) {
        pendingTranscribes.delete(msg.id);
        pending.reject(new Error(msg.message));
      }
    }
  });

  worker.addEventListener("error", (err) => {
    const message = err.message ?? "Worker error";
    if (pendingLoad) {
      const load = pendingLoad;
      pendingLoad = null;
      modelReady = false;
      load.reject(new Error(message));
    }
    for (const [id, pending] of pendingTranscribes) {
      pendingTranscribes.delete(id);
      pending.reject(new Error(message));
    }
  });

  return worker;
}

function ensureModel(
  modelTier: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const modelId = MODEL_IDS[modelTier];
  if (!modelId) {
    return Promise.reject(
      new Error(
        `Unknown model tier "${modelTier}". Valid options: ${Object.keys(MODEL_IDS).join(", ")}`,
      ),
    );
  }

  if (loadedModelTier === modelTier && modelReady) {
    return Promise.resolve();
  }

  const w = getOrCreateWorker();
  modelReady = false;
  loadedModelTier = modelTier;

  return new Promise<void>((resolve, reject) => {
    pendingLoad = { resolve, reject, onProgress };
    const id = nextId();
    w.postMessage({ type: "load", modelId, id } satisfies WorkerInMessage);
  });
}

function transcribe(audio: Float32Array, language: string): Promise<string> {
  if (!worker || !modelReady) {
    return Promise.reject(
      new Error("Model not ready. Call ensureModel first."),
    );
  }

  const id = nextId();
  return new Promise<string>((resolve, reject) => {
    pendingTranscribes.set(id, { resolve, reject });
    worker!.postMessage({
      type: "transcribe",
      audio,
      language,
      id,
    } satisfies WorkerInMessage);
  });
}

function isModelReady(modelTier?: string): boolean {
  if (modelTier !== undefined) {
    return modelReady && loadedModelTier === modelTier;
  }
  return modelReady;
}

function getLoadedModel(): string | null {
  return loadedModelTier;
}

function dispose(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
  modelReady = false;
  loadedModelTier = null;
  pendingLoad = null;
  pendingTranscribes.clear();
}

const whisperManager = {
  ensureModel,
  /** Alias for ensureModel, used by settings UI */
  downloadModel: ensureModel,
  transcribe,
  isModelReady,
  isModelCached,
  getLoadedModel,
  dispose,
};

export default whisperManager;

// Named exports for direct import
export { ensureModel, transcribe, isModelReady, isModelCached, getLoadedModel, dispose };
