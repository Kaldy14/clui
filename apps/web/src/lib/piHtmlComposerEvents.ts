import type { ThreadId } from "@clui/contracts";

const PI_HTML_COMPOSER_INSERT_EVENT = "clui:pi-html-composer-insert";

export type PiHtmlComposerInsertDetail = {
  threadId: ThreadId;
  text: string;
  source?: "insert" | "paste";
};

function isPiHtmlComposerInsertDetail(value: unknown): value is PiHtmlComposerInsertDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { threadId?: unknown }).threadId === "string" &&
    typeof (value as { text?: unknown }).text === "string" &&
    ((value as { source?: unknown }).source === undefined ||
      (value as { source?: unknown }).source === "insert" ||
      (value as { source?: unknown }).source === "paste")
  );
}

export function dispatchPiHtmlComposerInsert(detail: PiHtmlComposerInsertDetail): void {
  window.dispatchEvent(new CustomEvent<PiHtmlComposerInsertDetail>(PI_HTML_COMPOSER_INSERT_EVENT, { detail }));
}

export function addPiHtmlComposerInsertListener(
  listener: (detail: PiHtmlComposerInsertDetail) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (isPiHtmlComposerInsertDetail(detail)) listener(detail);
  };
  window.addEventListener(PI_HTML_COMPOSER_INSERT_EVENT, handler);
  return () => window.removeEventListener(PI_HTML_COMPOSER_INSERT_EVENT, handler);
}
