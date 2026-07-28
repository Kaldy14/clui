import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPiTranscriptFile } from "./piTranscript";

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clui-pi-transcript-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readPiTranscriptFile", () => {
  it("reads only entries appended after a valid offset", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "session.jsonl");
    const first = `${JSON.stringify({
      type: "custom_message",
      content: "first",
      timestamp: "2026-07-28T10:00:00.000Z",
    })}\n`;
    const second = `${JSON.stringify({
      type: "custom_message",
      content: "second",
      timestamp: "2026-07-28T10:01:00.000Z",
    })}\n`;
    await writeFile(filePath, first + second);

    const result = await readPiTranscriptFile(filePath, Buffer.byteLength(first));

    expect(result.reset).toBe(false);
    expect(result.offset).toBe(Buffer.byteLength(first + second));
    expect(result.items.map((item) => item.text)).toEqual(["second"]);
    expect(result.items[0]?.id).toBe(String(Buffer.byteLength(first)));
  });

  it("resets to the full transcript when the supplied offset is stale", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "session.jsonl");
    const line = `${JSON.stringify({ type: "custom_message", content: "hello" })}\n`;
    await writeFile(filePath, line);

    const result = await readPiTranscriptFile(filePath, Buffer.byteLength(line) + 10);

    expect(result.reset).toBe(true);
    expect(result.items.map((item) => item.text)).toEqual(["hello"]);
  });

  it("caps the usage lookback for incremental reads", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "session.jsonl");
    const prefix = "x".repeat(400 * 1024);
    const line = `${JSON.stringify({ type: "custom_message", content: "tail" })}\n`;
    await writeFile(filePath, prefix + line);

    const result = await readPiTranscriptFile(filePath, Buffer.byteLength(prefix));

    expect(result.items.map((item) => item.text)).toEqual(["tail"]);
    expect(result.usageTail.length).toBeLessThanOrEqual(256 * 1024);
  });
});
