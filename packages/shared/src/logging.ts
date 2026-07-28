import fs from "node:fs";
import path from "node:path";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
  readonly flushIntervalMs?: number;
  readonly maxBufferedBytes?: number;
}

export class RotatingFileSink {
  private static readonly DEFAULT_FLUSH_INTERVAL_MS = 50;
  private static readonly DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024;

  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedBytes: number;
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }
    const flushIntervalMs = options.flushIntervalMs ?? RotatingFileSink.DEFAULT_FLUSH_INTERVAL_MS;
    if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) {
      throw new Error(`flushIntervalMs must be >= 0 (received ${flushIntervalMs})`);
    }
    const maxBufferedBytes =
      options.maxBufferedBytes ?? RotatingFileSink.DEFAULT_MAX_BUFFERED_BYTES;
    if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new Error(`maxBufferedBytes must be >= 1 (received ${maxBufferedBytes})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferedBytes = maxBufferedBytes;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    this.pendingChunks.push(Buffer.from(buffer));
    this.pendingBytes += buffer.length;

    if (
      this.throwOnError ||
      this.flushIntervalMs === 0 ||
      this.pendingBytes >= this.maxBufferedBytes
    ) {
      this.flush();
      return;
    }

    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingBytes === 0) return;

    const buffer =
      this.pendingChunks.length === 1
        ? this.pendingChunks[0]!
        : Buffer.concat(this.pendingChunks, this.pendingBytes);
    this.pendingChunks = [];
    this.pendingBytes = 0;

    try {
      this.appendBuffer(buffer);
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  private appendBuffer(buffer: Buffer): void {
    let offset = 0;
    while (offset < buffer.length) {
      if (this.currentSize >= this.maxBytes) {
        this.rotate();
      }

      const remainingFileBytes = this.maxBytes - this.currentSize;
      const bytesToWrite = Math.min(remainingFileBytes, buffer.length - offset);
      fs.appendFileSync(this.filePath, buffer.subarray(offset, offset + bytesToWrite));
      this.currentSize += bytesToWrite;
      offset += bytesToWrite;
    }
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
