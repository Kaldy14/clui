import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

type IncomingMessage =
  | { type: "load"; modelId: string }
  | { type: "transcribe"; audio: Float32Array; language: string };

type OutgoingMessage =
  | { type: "ready" }
  | { type: "result"; text: string }
  | { type: "error"; message: string }
  | {
      type: "progress";
      progress: { status: string; file?: string; progress?: number };
    };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedModelId: string | null = null;

// Worker postMessage doesn't take targetOrigin — disable false-positive lint rule
/* oxlint-disable unicorn/require-post-message-target-origin */

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;

  if (msg.type === "load") {
    const { modelId } = msg;
    if (loadedModelId === modelId && asr !== null) {
      self.postMessage({ type: "ready" } satisfies OutgoingMessage);
      return;
    }

    try {
      asr = null;
      loadedModelId = null;

      // @ts-expect-error: pipeline() return union is too wide for tsc to represent
      asr = (await pipeline("automatic-speech-recognition", modelId, {
        progress_callback: (progress: {
          status: string;
          file?: string;
          progress?: number;
        }) => {
          self.postMessage({
            type: "progress",
            progress,
          } satisfies OutgoingMessage);
        },
      })) as AutomaticSpeechRecognitionPipeline;

      loadedModelId = modelId;
      self.postMessage({ type: "ready" } satisfies OutgoingMessage);
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      } satisfies OutgoingMessage);
    }
    return;
  }

  if (msg.type === "transcribe") {
    if (!asr) {
      self.postMessage({
        type: "error",
        message: "Model not loaded. Call load first.",
      } satisfies OutgoingMessage);
      return;
    }

    try {
      const result = await asr(msg.audio, {
        language: msg.language,
        task: "transcribe",
      });

      const text = Array.isArray(result)
        ? (result[0]?.text ?? "")
        : (result.text ?? "");

      self.postMessage({ type: "result", text } satisfies OutgoingMessage);
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      } satisfies OutgoingMessage);
    }
  }
};
