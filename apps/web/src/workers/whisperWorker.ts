import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

type IncomingMessage =
  | { type: "load"; modelId: string; id: string }
  | { type: "transcribe"; audio: Float32Array; language: string; id: string };

type OutgoingMessage =
  | { type: "ready"; id: string }
  | { type: "result"; text: string; id: string }
  | { type: "error"; message: string; id: string }
  | {
      type: "progress";
      progress: { status: string; file?: string; progress?: number };
      id: string;
    };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedModelId: string | null = null;

// Worker postMessage doesn't take targetOrigin — disable false-positive lint rule
/* oxlint-disable unicorn/require-post-message-target-origin */

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;

  if (msg.type === "load") {
    const { modelId, id } = msg;
    if (loadedModelId === modelId && asr !== null) {
      self.postMessage({ type: "ready", id } satisfies OutgoingMessage);
      return;
    }

    try {
      asr = null;
      loadedModelId = null;

      // Prefer WebGPU for fast inference, fall back to WASM.
      // Use fp32 on WebGPU (quantised types aren't always supported),
      // and q8 quantisation on WASM so it doesn't crawl.
      let device: "webgpu" | "wasm" = "wasm";
      let dtype: "fp32" | "fp16" | "q8" | "q4" | "int8" | "uint8" | "auto" = "q8";
      try {
        if (typeof navigator !== "undefined" && "gpu" in navigator) {
          const gpu = navigator as unknown as { gpu: { requestAdapter(): Promise<unknown | null> } };
          const adapter = await gpu.gpu.requestAdapter();
          if (adapter) {
            device = "webgpu";
            dtype = "fp32";
          }
        }
      } catch {
        // WebGPU not available — stick with WASM
      }

      // @ts-expect-error: pipeline() return union is too wide for tsc to represent
      asr = (await pipeline("automatic-speech-recognition", modelId, {
        device,
        dtype,
        progress_callback: (progress: {
          status: string;
          file?: string;
          progress?: number;
        }) => {
          self.postMessage({
            type: "progress",
            progress,
            id,
          } satisfies OutgoingMessage);
        },
      })) as AutomaticSpeechRecognitionPipeline;

      loadedModelId = modelId;
      self.postMessage({ type: "ready", id } satisfies OutgoingMessage);
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        id,
      } satisfies OutgoingMessage);
    }
    return;
  }

  if (msg.type === "transcribe") {
    const { id } = msg;
    if (!asr) {
      self.postMessage({
        type: "error",
        message: "Model not loaded. Call load first.",
        id,
      } satisfies OutgoingMessage);
      return;
    }

    try {
      const result = await asr(msg.audio, {
        language: msg.language,
        task: "transcribe",
        // Enable chunked processing for audio > 30s so the model doesn't
        // choke on long recordings. 30s chunks with 5s overlap.
        chunk_length_s: 30,
        stride_length_s: 5,
      });

      const text = Array.isArray(result)
        ? (result[0]?.text ?? "")
        : (result.text ?? "");

      self.postMessage({ type: "result", text, id } satisfies OutgoingMessage);
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        id,
      } satisfies OutgoingMessage);
    }
  }
};
