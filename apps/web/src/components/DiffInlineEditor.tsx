import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { bracketMatching } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { Loader2, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { cluiDarkEditorTheme, cluiDarkHighlightStyle } from "~/lib/diffEditorTheme";

export interface DiffInlineEditorProps {
  filePath: string;
  initialContent: string;
  language: string;
  onSave: (content: string) => void;
  onCancel: () => void;
  isSaving: boolean;
  /** Line number (1-based) to scroll to and highlight on mount. */
  scrollToLine?: number | undefined;
}

function getLanguageExtension(lang: string): Extension {
  switch (lang) {
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "css":
      return css();
    case "html":
      return html();
    case "markdown":
      return markdown();
    default:
      return [];
  }
}

function splitFilePath(filePath: string): { dir: string; base: string } {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", base: filePath };
  return {
    dir: filePath.slice(0, lastSlash + 1),
    base: filePath.slice(lastSlash + 1),
  };
}

export default function DiffInlineEditor({
  filePath,
  initialContent,
  language,
  onSave,
  onCancel,
  isSaving,
  scrollToLine,
}: DiffInlineEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onCancelRef = useRef(onCancel);
  const isDirtyRef = useRef(false);
  const initialContentRef = useRef(initialContent);

  onSaveRef.current = onSave;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const state = EditorState.create({
      doc: initialContentRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        bracketMatching(),
        history(),
        keymap.of([
          {
            key: "Mod-s",
            run: (v) => {
              onSaveRef.current(v.state.doc.toString());
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        cluiDarkEditorTheme,
        cluiDarkHighlightStyle,
        getLanguageExtension(language),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            isDirtyRef.current = update.state.doc.toString() !== initialContentRef.current;
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    view.focus();

    // Scroll to the first changed line so the user lands right at the diff
    if (scrollToLine && scrollToLine > 0) {
      const lineInfo = view.state.doc.line(Math.min(scrollToLine, view.state.doc.lines));
      view.dispatch({
        selection: { anchor: lineInfo.from },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
      });
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language, scrollToLine]);

  const handleCancel = useCallback(() => {
    if (isDirtyRef.current) {
      if (!window.confirm("Discard unsaved changes?")) return;
    }
    onCancelRef.current();
  }, []);

  const handleSave = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    onSaveRef.current(view.state.doc.toString());
  }, []);

  const { dir, base } = splitFilePath(filePath);

  return (
    <div className="rounded-md overflow-hidden" style={{ border: "1px solid #30363d" }}>
      {/* Header */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5"
        style={{ backgroundColor: "#252a31", borderBottom: "1px solid #30363d" }}
      >
        <div className="flex items-center gap-1 min-w-0 text-sm font-mono">
          <span className="text-[#858585] truncate">{dir}</span>
          <span className="text-[#D4D4D4] font-semibold">{base}</span>
          {isDirtyRef.current && (
            <span className="text-[#858585] text-xs ml-1">(modified)</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: "#2563eb" }}
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSaving}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[#D4D4D4] hover:text-white disabled:opacity-50"
            style={{ backgroundColor: "#2a2f38", border: "1px solid #30363d" }}
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>
      </div>

      {/* Editor */}
      <div ref={containerRef} className="max-h-[70vh] overflow-auto" />
    </div>
  );
}
