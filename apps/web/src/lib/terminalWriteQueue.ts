export interface TerminalWriteTarget {
  write(data: string, callback?: () => void): void;
}

export interface TerminalWriteQueue {
  enqueue(data: string, onComplete?: () => void): void;
  clear(): void;
  dispose(): void;
  readonly pendingCount: number;
  readonly writing: boolean;
}

interface QueueItem {
  data: string;
  onComplete?: () => void;
}

export function createTerminalWriteQueue(target: TerminalWriteTarget): TerminalWriteQueue {
  const queue: QueueItem[] = [];
  let writing = false;
  let disposed = false;

  const pump = () => {
    if (disposed || writing) return;
    const item = queue.shift();
    if (!item) return;

    if (item.data.length === 0) {
      item.onComplete?.();
      queueMicrotask(pump);
      return;
    }

    writing = true;
    target.write(item.data, () => {
      writing = false;
      item.onComplete?.();
      pump();
    });
  };

  return {
    enqueue(data, onComplete) {
      if (disposed) return;
      queue.push(onComplete ? { data, onComplete } : { data });
      pump();
    },
    clear() {
      queue.length = 0;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
    },
    get pendingCount() {
      return queue.length;
    },
    get writing() {
      return writing;
    },
  };
}
