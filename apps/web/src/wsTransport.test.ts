import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WsTransport } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(_url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  serverMessage(data: unknown) {
    this.emit("message", { data });
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

beforeEach(() => {
  sockets.length = 0;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("routes valid push envelopes to channel listeners", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe("providers.event", listener);

    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: "providers.event",
        data: { status: "ok" },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: "ok" });

    transport.dispose();
  });

  it("resolves pending requests for valid response envelopes", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("projects.list");
    const sent = socket.sent.at(-1);
    if (!sent) {
      throw new Error("Expected request envelope to be sent");
    }

    const requestEnvelope = JSON.parse(sent) as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: [] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: [] });

    transport.dispose();
  });

  it("drops malformed envelopes without crashing transport", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe("providers.event", listener);

    socket.serverMessage("{ invalid-json");
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: 42,
        data: { bad: true },
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: "providers.event",
        data: { ok: true },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ ok: true });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, "Dropped inbound WebSocket envelope", {
      reason: "decode-failed",
      issue:
        "SchemaError: SyntaxError: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
      raw: "{ invalid-json",
    });
    expect(warnSpy).toHaveBeenNthCalledWith(2, "Dropped inbound WebSocket envelope", {
      reason: "decode-failed",
      issue: expect.stringContaining("Expected string, got 42"),
      raw: '{"type":"push","channel":42,"data":{"bad":true}}',
    });

    transport.dispose();
  });

  it("queues disconnected messages without polling and coalesces resize updates", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    transport.fireAndForget(
      "terminal.resize",
      { threadId: "thread-1", terminalId: "main", cols: 80, rows: 20 },
      { coalesceKey: "terminal.resize:thread-1:main" },
    );
    transport.fireAndForget("terminal.write", {
      threadId: "thread-1",
      terminalId: "main",
      data: "hello",
    });
    transport.fireAndForget(
      "terminal.resize",
      { threadId: "thread-1", terminalId: "main", cols: 120, rows: 40 },
      { coalesceKey: "terminal.resize:thread-1:main" },
    );

    expect(socket.sent).toEqual([]);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    socket.open();

    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[0]!) as { body: { _tag: string; data: string } }).toMatchObject({
      body: { _tag: "terminal.write", data: "hello" },
    });
    expect(
      JSON.parse(socket.sent[1]!) as { body: { _tag: string; cols: number; rows: number } },
    ).toMatchObject({
      body: { _tag: "terminal.resize", cols: 120, rows: 40 },
    });

    transport.dispose();
  });

  it("bounds disconnected fire-and-forget messages", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    for (let index = 0; index < 300; index += 1) {
      transport.fireAndForget("terminal.write", {
        threadId: "thread-1",
        terminalId: "main",
        data: String(index),
      });
    }

    socket.open();

    expect(socket.sent).toHaveLength(256);
    expect(
      JSON.parse(socket.sent[0]!) as {
        body: { data: string };
      },
    ).toMatchObject({ body: { data: "44" } });
    expect(
      JSON.parse(socket.sent.at(-1)!) as {
        body: { data: string };
      },
    ).toMatchObject({ body: { data: "299" } });

    transport.dispose();
  });

  it("removes timed-out requests from the disconnected queue", async () => {
    vi.useFakeTimers();
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const request = transport.request("projects.list", undefined, { timeoutMs: 100 });
    const expectation = expect(request).rejects.toThrow("Request timed out: projects.list");
    await vi.advanceTimersByTimeAsync(100);
    await expectation;

    socket.open();
    expect(socket.sent).toEqual([]);

    transport.dispose();
    vi.useRealTimers();
  });
});
