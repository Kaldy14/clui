import { registerCustomTheme } from "@pierre/diffs";

const CLUI_DARK_THEME = {
  name: "clui-dark",
  type: "dark" as const,
  colors: {
    "editor.background": "#1b1e23",
    "editor.foreground": "#D4D4D4",
    "editorLineNumber.foreground": "#858585",
    "editorLineNumber.activeForeground": "#C6C6C6",
  },
  tokenColors: [
    // Comments
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#6A9955" },
    },
    // Keywords (const, let, var, if, return, class, function, import, export, etc.)
    {
      scope: [
        "keyword",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.operator.logical",
        "keyword.operator.delete",
        "keyword.operator.typeof",
        "keyword.operator.void",
        "keyword.operator.instanceof",
        "keyword.operator.in",
      ],
      settings: { foreground: "#559CD6" },
    },
    // Strings
    {
      scope: ["string", "string.template", "punctuation.definition.string"],
      settings: { foreground: "#CE9178" },
    },
    // Template literal expressions ${...}
    {
      scope: ["punctuation.definition.template-expression", "punctuation.section.embedded"],
      settings: { foreground: "#559CD6" },
    },
    // Numbers
    { scope: ["constant.numeric"], settings: { foreground: "#B5CDA8" } },
    // Booleans and null/undefined
    { scope: ["constant.language"], settings: { foreground: "#559CD6" } },
    // Functions
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#DCDCAA" },
    },
    // Classes, interfaces, types
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
        "storage.type.interface",
        "entity.name.type.interface",
        "entity.name.type.alias",
        "entity.name.type.enum",
        "entity.name.type.class",
      ],
      settings: { foreground: "#3FC8B0" },
    },
    // Variables and parameters
    {
      scope: [
        "variable",
        "variable.other.readwrite",
        "variable.parameter",
        "meta.definition.variable",
      ],
      settings: { foreground: "#9CDCFE" },
    },
    // Properties
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "meta.object-literal.key",
        "support.variable.property",
      ],
      settings: { foreground: "#9CDCFE" },
    },
    // Operators
    {
      scope: [
        "keyword.operator",
        "keyword.operator.assignment",
        "keyword.operator.arithmetic",
        "keyword.operator.comparison",
        "keyword.operator.ternary",
        "keyword.operator.spread",
      ],
      settings: { foreground: "#D4D4D4" },
    },
    // Brackets and parens (golden)
    {
      scope: [
        "punctuation.definition.block",
        "punctuation.definition.parameters",
        "meta.brace.round",
        "meta.brace.square",
        "meta.brace.curly",
        "punctuation.definition.array",
        "punctuation.section.property-list",
        "punctuation.accessor",
      ],
      settings: { foreground: "#FFD700" },
    },
    // Punctuation (commas, semicolons) - keep subtle
    {
      scope: ["punctuation.separator", "punctuation.terminator"],
      settings: { foreground: "#D4D4D4" },
    },
    // Type annotations (TypeScript)
    {
      scope: ["meta.type.annotation", "entity.name.type.module"],
      settings: { foreground: "#3FC8B0" },
    },
    // Decorators
    {
      scope: ["meta.decorator", "punctuation.decorator"],
      settings: { foreground: "#DCDCAA" },
    },
    // Regular expressions
    { scope: ["string.regexp"], settings: { foreground: "#D16969" } },
    // JSON keys
    {
      scope: ["support.type.property-name.json"],
      settings: { foreground: "#9CDCFE" },
    },
    // CSS
    {
      scope: ["entity.other.attribute-name", "support.type.property-name.css"],
      settings: { foreground: "#9CDCFE" },
    },
    {
      scope: ["support.constant.property-value.css", "support.constant.color.css"],
      settings: { foreground: "#CE9178" },
    },
    // HTML/JSX tags
    {
      scope: ["entity.name.tag", "support.class.component"],
      settings: { foreground: "#559CD6" },
    },
    // JSX/HTML attribute names
    {
      scope: [
        "entity.other.attribute-name.jsx",
        "entity.other.attribute-name.html",
        "entity.other.attribute-name.tsx",
      ],
      settings: { foreground: "#9CDCFE" },
    },
    // Markdown
    { scope: ["markup.heading"], settings: { foreground: "#559CD6" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    {
      scope: ["markup.inline.raw", "markup.fenced_code"],
      settings: { foreground: "#CE9178" },
    },
    // Diff-specific (if any inline diff tokens exist)
    { scope: ["markup.inserted"], settings: { foreground: "#B5CDA8" } },
    { scope: ["markup.deleted"], settings: { foreground: "#CE9178" } },
  ],
};

export function registerCluiDarkTheme() {
  registerCustomTheme("clui-dark", async () => CLUI_DARK_THEME);
}
