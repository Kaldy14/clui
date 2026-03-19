import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const cluiDarkEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#1b1e23",
      color: "#D4D4D4",
      fontSize: "13px",
      fontFamily: "var(--font-mono, ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace)",
    },
    ".cm-content": {
      caretColor: "#D4D4D4",
      padding: "4px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#D4D4D4",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#264f78 !important",
    },
    ".cm-gutters": {
      backgroundColor: "#252a31",
      color: "#858585",
      borderRight: "1px solid #30363d",
      minWidth: "40px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#2a2f38",
      color: "#C6C6C6",
    },
    ".cm-activeLine": {
      backgroundColor: "#22272e",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "#3a3d41",
      outline: "1px solid #888",
    },
    ".cm-searchMatch": {
      backgroundColor: "#515c6a",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "#264f78",
    },
    ".cm-selectionMatch": {
      backgroundColor: "#3a3d41",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#252a31",
      border: "1px solid #30363d",
      color: "#858585",
    },
    ".cm-tooltip": {
      backgroundColor: "#252a31",
      border: "1px solid #30363d",
      color: "#D4D4D4",
    },
    ".cm-panels": {
      backgroundColor: "#252a31",
      color: "#D4D4D4",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid #30363d",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid #30363d",
    },
    ".cm-panel.cm-search": {
      backgroundColor: "#252a31",
    },
    ".cm-panel.cm-search input": {
      backgroundColor: "#1b1e23",
      border: "1px solid #30363d",
      color: "#D4D4D4",
    },
    ".cm-panel.cm-search button": {
      backgroundColor: "#2a2f38",
      border: "1px solid #30363d",
      color: "#D4D4D4",
    },
  },
  { dark: true },
);

// Syntax highlighting matching clui-dark shiki theme
export const cluiDarkHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "#559CD6" },
    { tag: tags.controlKeyword, color: "#559CD6" },
    { tag: tags.operatorKeyword, color: "#559CD6" },
    { tag: tags.definitionKeyword, color: "#559CD6" },
    { tag: tags.moduleKeyword, color: "#559CD6" },
    { tag: tags.modifier, color: "#559CD6" },
    { tag: tags.string, color: "#CE9178" },
    { tag: tags.special(tags.string), color: "#CE9178" },
    { tag: tags.regexp, color: "#D16969" },
    { tag: tags.number, color: "#B5CDA8" },
    { tag: tags.bool, color: "#559CD6" },
    { tag: tags.null, color: "#559CD6" },
    { tag: tags.atom, color: "#559CD6" },
    { tag: tags.function(tags.variableName), color: "#DCDCAA" },
    { tag: tags.function(tags.definition(tags.variableName)), color: "#DCDCAA" },
    { tag: tags.function(tags.propertyName), color: "#DCDCAA" },
    { tag: tags.typeName, color: "#3FC8B0" },
    { tag: tags.className, color: "#3FC8B0" },
    { tag: tags.definition(tags.typeName), color: "#3FC8B0" },
    { tag: tags.namespace, color: "#3FC8B0" },
    { tag: tags.variableName, color: "#9CDCFE" },
    { tag: tags.definition(tags.variableName), color: "#9CDCFE" },
    { tag: tags.propertyName, color: "#9CDCFE" },
    { tag: tags.comment, color: "#6A9955" },
    { tag: tags.lineComment, color: "#6A9955" },
    { tag: tags.blockComment, color: "#6A9955" },
    { tag: tags.docComment, color: "#6A9955" },
    { tag: tags.operator, color: "#D4D4D4" },
    { tag: tags.punctuation, color: "#D4D4D4" },
    { tag: tags.bracket, color: "#FFD700" },
    { tag: tags.squareBracket, color: "#FFD700" },
    { tag: tags.paren, color: "#FFD700" },
    { tag: tags.brace, color: "#FFD700" },
    { tag: tags.angleBracket, color: "#D4D4D4" },
    { tag: tags.separator, color: "#D4D4D4" },
    { tag: tags.tagName, color: "#559CD6" },
    { tag: tags.attributeName, color: "#9CDCFE" },
    { tag: tags.attributeValue, color: "#CE9178" },
    { tag: tags.heading, color: "#559CD6", fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.link, color: "#559CD6", textDecoration: "underline" },
    { tag: tags.meta, color: "#559CD6" },
    { tag: tags.invalid, color: "#F44747" },
    { tag: tags.inserted, color: "#B5CDA8" },
    { tag: tags.deleted, color: "#CE9178" },
  ]),
);
