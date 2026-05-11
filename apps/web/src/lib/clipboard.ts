type ClipboardDataTransferItem = Pick<DataTransferItem, "kind" | "type">;

export function clipboardItemsContainImageFile(
  items: ArrayLike<ClipboardDataTransferItem | null | undefined> | null | undefined,
): boolean {
  if (!items) return false;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind === "file" && item.type.startsWith("image/")) {
      return true;
    }
  }

  return false;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  // Try the modern Clipboard API first, then fall back to execCommand for cases
  // where browser user activation has expired (for example native context menus
  // in Electron).
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or transient activation expired — try legacy fallback.
    }
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("execCommand('copy') returned false.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
