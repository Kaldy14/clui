import { WebSocketResponse, WsPush, WsResponse } from "@clui/contracts";
import { Cause, Schema } from "effect";

type PushListener = (data: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RequestOptions {
  readonly timeoutMs?: number;
}

interface FireAndForgetOptions {
  /** Keep only the latest disconnected message for this key. */
  readonly coalesceKey?: string;
}

const REQUEST_TIMEOUT_MS = 120_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const MAX_QUEUED_OUTBOUND_MESSAGES = 256;
const decodeWsResponseFromJson = Schema.decodeUnknownExit(Schema.fromJsonString(WsResponse));
const isWsPushEnvelope = Schema.is(WsPush);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface QueuedOutboundMessage {
  readonly message: WsRequestEnvelope;
  readonly tracked: boolean;
  readonly coalesceKey?: string;
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<PushListener>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outboundQueue: QueuedOutboundMessage[] = [];
  private disposed = false;
  private readonly url: string;

  constructor(url?: string) {
    const bridgeUrl = window.desktopBridge?.getWsUrl();
    // In dev mode, VITE_WS_URL points to the server's WebSocket endpoint.
    // In production, the page is served by the WS server on the same host:port.
    const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
    this.url =
      url ??
      (bridgeUrl && bridgeUrl.length > 0
        ? bridgeUrl
        : envUrl && envUrl.length > 0
          ? envUrl
          : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`);
    this.connect();
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("Request method is required");
    }
    const id = String(this.nextId++);
    const body = params != null ? { ...params, _tag: method } : { _tag: method };
    const message: WsRequestEnvelope = { id, body };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.removeQueuedMessage(id);
        reject(new Error(`Request timed out: ${method}`));
      }, options?.timeoutMs ?? REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.send(message, { tracked: true });
    });
  }

  /**
   * Send a request without waiting for or tracking a response.
   * Use for operations where the result is not needed (e.g., terminal write/resize).
   */
  fireAndForget(method: string, params?: unknown, options?: FireAndForgetOptions): void {
    if (typeof method !== "string" || method.length === 0) return;
    const id = String(this.nextId++);
    const body = params != null ? { ...params, _tag: method } : { _tag: method };
    this.send(
      { id, body },
      {
        tracked: false,
        ...(options?.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
      },
    );
  }

  subscribe(channel: string, listener: PushListener): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);

    return () => {
      channelListeners!.delete(listener);
      if (channelListeners!.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending("Transport disposed");
    this.outboundQueue.length = 0;
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.disposed) return;

    const ws = new WebSocket(this.url);

    ws.addEventListener("open", () => {
      this.ws = ws;
      this.reconnectAttempt = 0;
      this.flushOutboundQueue();
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.rejectPending("Connection lost");
      this.outboundQueue.length = 0;
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event will fire after error
    });
  }

  private handleMessage(raw: unknown) {
    const exit = decodeWsResponseFromJson(raw);
    if (exit._tag === "Failure") {
      console.warn("Dropped inbound WebSocket envelope", {
        reason: "decode-failed",
        raw,
        issue: Cause.pretty(exit.cause),
      });
      return;
    }
    const message = exit.value;

    // Push event
    if (isWsPushEnvelope(message)) {
      const channelListeners = this.listeners.get(message.channel);
      if (channelListeners) {
        for (const listener of channelListeners) {
          try {
            listener(message.data);
          } catch {
            // Swallow listener errors
          }
        }
      }
      return;
    }

    // Response to a request
    if (!isWebSocketResponseEnvelope(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private send(
    message: WsRequestEnvelope,
    options: { readonly tracked: boolean; readonly coalesceKey?: string },
  ) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }

    if (this.disposed) return;
    this.enqueueOutboundMessage({
      message,
      tracked: options.tracked,
      ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
    });
  }

  private enqueueOutboundMessage(queued: QueuedOutboundMessage): void {
    if (queued.coalesceKey) {
      const existingIndex = this.outboundQueue.findIndex(
        (candidate) => candidate.coalesceKey === queued.coalesceKey,
      );
      if (existingIndex >= 0) {
        this.outboundQueue.splice(existingIndex, 1);
      }
    }

    if (this.outboundQueue.length >= MAX_QUEUED_OUTBOUND_MESSAGES) {
      const droppableIndex = this.outboundQueue.findIndex((candidate) => !candidate.tracked);
      if (droppableIndex >= 0) {
        this.outboundQueue.splice(droppableIndex, 1);
      } else if (queued.tracked) {
        const pending = this.pending.get(queued.message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(queued.message.id);
          pending.reject(new Error("Outbound WebSocket queue is full"));
        }
        return;
      } else {
        return;
      }
    }

    this.outboundQueue.push(queued);
  }

  private flushOutboundQueue(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const queued = this.outboundQueue.splice(0);
    for (const item of queued) {
      if (item.tracked && !this.pending.has(item.message.id)) continue;
      ws.send(JSON.stringify(item.message));
    }
  }

  private removeQueuedMessage(id: string): void {
    const index = this.outboundQueue.findIndex((queued) => queued.message.id === id);
    if (index >= 0) {
      this.outboundQueue.splice(index, 1);
    }
  }

  private rejectPending(reason: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private scheduleReconnect() {
    if (this.disposed) return;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0]!;

    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
