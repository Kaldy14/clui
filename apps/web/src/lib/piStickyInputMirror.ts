import type { Terminal } from "@xterm/xterm";
import type { CSSProperties } from "react";

export type PiStickyInputMirrorStyle = CSSProperties;

export interface PiStickyInputMirrorSegment {
  text: string;
  style: PiStickyInputMirrorStyle;
  styleKey: string;
}

export interface PiStickyInputMirrorLine {
  plainText: string;
  segments: PiStickyInputMirrorSegment[];
}

export interface PiStickyInputMirror {
  lines: PiStickyInputMirrorLine[];
}

const MIN_DIVIDER_HORIZONTAL_CHARS = 12;
const MIN_DIVIDER_RATIO = 0.6;
const MIN_DIVIDER_WIDTH_RATIO = 0.45;
// pi's editor can grow much taller on large viewports and when the user writes
// multi-line prompts with blank lines. Keep these limits generous so the sticky
// mirror doesn't disappear mid-draft just because the editor exceeded the first
// prototype's small heuristic window.
const MAX_EDITOR_BODY_LINES = 40;
const MAX_LOOKBACK_LINES = 48;

const ANSI_COLOR_DEFAULTS = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
] as const;

function countHorizontalRuleChars(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === "─") count += 1;
  }
  return count;
}

function countNonWhitespaceChars(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char.trim().length > 0) count += 1;
  }
  return count;
}

function normalizeLine(line: string): string {
  return line.replace(/\u00a0/g, " ").replace(/\s+$/u, "");
}

function isDividerLine(line: string, width: number): boolean {
  const normalized = normalizeLine(line);
  if (normalized.length === 0) return false;

  const horizontalChars = countHorizontalRuleChars(normalized);
  if (horizontalChars < MIN_DIVIDER_HORIZONTAL_CHARS) return false;

  const minWidthChars = Math.max(MIN_DIVIDER_HORIZONTAL_CHARS, Math.floor(width * MIN_DIVIDER_WIDTH_RATIO));
  if (horizontalChars < minWidthChars) return false;

  const nonWhitespaceChars = countNonWhitespaceChars(normalized);
  return horizontalChars / Math.max(1, nonWhitespaceChars) >= MIN_DIVIDER_RATIO;
}

interface PiStickyInputMirrorRange {
  startIndex: number;
  endIndex: number;
}

function extractPiStickyInputMirrorRange(
  lines: readonly string[],
  width: number,
): PiStickyInputMirrorRange | null {
  if (lines.length < 3 || width <= 0) return null;

  let bottomDividerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isDividerLine(lines[index] ?? "", width)) {
      bottomDividerIndex = index;
      break;
    }
  }

  if (bottomDividerIndex <= 0) return null;

  const topDividerFloor = Math.max(0, bottomDividerIndex - MAX_LOOKBACK_LINES);
  let topDividerIndex = -1;
  for (let index = bottomDividerIndex - 1; index >= topDividerFloor; index -= 1) {
    if (isDividerLine(lines[index] ?? "", width)) {
      topDividerIndex = index;
      break;
    }
  }

  if (topDividerIndex === -1) return null;

  const bodyLineCount = bottomDividerIndex - topDividerIndex - 1;
  if (bodyLineCount < 1 || bodyLineCount > MAX_EDITOR_BODY_LINES) return null;

  return {
    startIndex: topDividerIndex,
    endIndex: bottomDividerIndex,
  };
}

export function extractPiStickyInputMirrorFromLines(
  lines: readonly string[],
  width: number,
): { lines: string[] } | null {
  const range = extractPiStickyInputMirrorRange(lines, width);
  if (!range) return null;

  return {
    lines: lines.slice(range.startIndex, range.endIndex + 1).map((line) => normalizeLine(line)),
  };
}

function rgbNumberToHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function getAnsiPalette(theme: Terminal["options"]["theme"]): string[] {
  return [
    theme?.black ?? ANSI_COLOR_DEFAULTS[0],
    theme?.red ?? ANSI_COLOR_DEFAULTS[1],
    theme?.green ?? ANSI_COLOR_DEFAULTS[2],
    theme?.yellow ?? ANSI_COLOR_DEFAULTS[3],
    theme?.blue ?? ANSI_COLOR_DEFAULTS[4],
    theme?.magenta ?? ANSI_COLOR_DEFAULTS[5],
    theme?.cyan ?? ANSI_COLOR_DEFAULTS[6],
    theme?.white ?? ANSI_COLOR_DEFAULTS[7],
    theme?.brightBlack ?? ANSI_COLOR_DEFAULTS[8],
    theme?.brightRed ?? ANSI_COLOR_DEFAULTS[9],
    theme?.brightGreen ?? ANSI_COLOR_DEFAULTS[10],
    theme?.brightYellow ?? ANSI_COLOR_DEFAULTS[11],
    theme?.brightBlue ?? ANSI_COLOR_DEFAULTS[12],
    theme?.brightMagenta ?? ANSI_COLOR_DEFAULTS[13],
    theme?.brightCyan ?? ANSI_COLOR_DEFAULTS[14],
    theme?.brightWhite ?? ANSI_COLOR_DEFAULTS[15],
    ...(theme?.extendedAnsi ?? []),
  ];
}

function resolvePaletteColor(index: number, palette: readonly string[]): string {
  if (index >= 0 && index < palette.length) return palette[index]!;

  if (index >= 16 && index <= 231) {
    const cubeIndex = index - 16;
    const red = Math.floor(cubeIndex / 36);
    const green = Math.floor((cubeIndex % 36) / 6);
    const blue = cubeIndex % 6;
    const values = [0, 95, 135, 175, 215, 255];
    return rgbNumberToHex((values[red]! << 16) | (values[green]! << 8) | values[blue]!);
  }

  if (index >= 232 && index <= 255) {
    const value = 8 + (index - 232) * 10;
    return rgbNumberToHex((value << 16) | (value << 8) | value);
  }

  return palette[7] ?? ANSI_COLOR_DEFAULTS[7];
}

function resolveCellColor(
  cell: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>> extends infer _T ? any : never,
  channel: "fg" | "bg",
  palette: readonly string[],
  defaultColor: string,
): string {
  const isRgb = channel === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = channel === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const isDefault = channel === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  const color = channel === "fg" ? cell.getFgColor() : cell.getBgColor();

  if (isDefault) return defaultColor;
  if (isRgb) return rgbNumberToHex(color);
  if (isPalette) return resolvePaletteColor(color, palette);
  return defaultColor;
}

function buildDecorationLine(cell: {
  isUnderline(): number;
  isStrikethrough(): number;
  isOverline(): number;
}): string | undefined {
  const decorations: string[] = [];
  if (cell.isUnderline()) decorations.push("underline");
  if (cell.isStrikethrough()) decorations.push("line-through");
  if (cell.isOverline()) decorations.push("overline");
  return decorations.length > 0 ? decorations.join(" ") : undefined;
}

function buildSegmentStyle(
  cell: {
    isBold(): number;
    isItalic(): number;
    isDim(): number;
    isInverse(): number;
    isInvisible(): number;
    isUnderline(): number;
    isStrikethrough(): number;
    isOverline(): number;
    isFgRGB(): boolean;
    isBgRGB(): boolean;
    isFgPalette(): boolean;
    isBgPalette(): boolean;
    isFgDefault(): boolean;
    isBgDefault(): boolean;
    getFgColor(): number;
    getBgColor(): number;
  },
  palette: readonly string[],
  defaultForeground: string,
  defaultBackground: string,
): PiStickyInputMirrorStyle {
  let foreground = resolveCellColor(cell, "fg", palette, defaultForeground);
  let background = resolveCellColor(cell, "bg", palette, defaultBackground);

  if (cell.isInverse()) {
    [foreground, background] = [background, foreground];
  }

  const style: PiStickyInputMirrorStyle = {};
  if (foreground !== defaultForeground) style.color = foreground;
  if (background !== defaultBackground) style.backgroundColor = background;
  if (cell.isBold()) style.fontWeight = "700";
  if (cell.isItalic()) style.fontStyle = "italic";
  const decorationLine = buildDecorationLine(cell);
  if (decorationLine) style.textDecorationLine = decorationLine;
  if (cell.isDim()) style.opacity = 0.7;
  if (cell.isInvisible()) style.visibility = "hidden";
  return style;
}

function getStyleKey(style: PiStickyInputMirrorStyle): string {
  return [
    style.color ?? "",
    style.backgroundColor ?? "",
    style.fontWeight ?? "",
    style.fontStyle ?? "",
    style.textDecorationLine ?? "",
    style.opacity?.toString() ?? "",
    style.visibility ?? "",
  ].join("|");
}

function buildMirrorLine(
  terminal: Terminal,
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
): PiStickyInputMirrorLine {
  const theme = terminal.options.theme;
  const defaultForeground = theme?.foreground ?? "#ffffff";
  const defaultBackground = theme?.background ?? "#000000";
  const palette = getAnsiPalette(theme);
  const nullCell = terminal.buffer.active.getNullCell();
  const segments: PiStickyInputMirrorSegment[] = [];

  for (let column = 0; column < terminal.cols; column += 1) {
    const cell = line.getCell(column, nullCell);
    if (!cell || cell.getWidth() === 0) continue;

    const text = cell.getChars() || " ";
    const style = buildSegmentStyle(cell, palette, defaultForeground, defaultBackground);
    const styleKey = getStyleKey(style);
    const previous = segments[segments.length - 1];
    if (previous && previous.styleKey === styleKey) {
      previous.text += text;
      continue;
    }
    segments.push({ text, style, styleKey });
  }

  return {
    plainText: normalizeLine(line.translateToString(true, 0, terminal.cols)),
    segments,
  };
}

export function readPiStickyInputMirror(terminal: Terminal): PiStickyInputMirror | null {
  if (terminal.rows <= 0 || terminal.cols <= 0) return null;

  const buffer = terminal.buffer.active;
  if (buffer.type !== "normal") return null;

  const bottomPageStart = Math.max(0, buffer.baseY);
  const bottomPageLines: PiStickyInputMirrorLine[] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(bottomPageStart + row);
    if (!line) {
      bottomPageLines.push({ plainText: "", segments: [] });
      continue;
    }
    bottomPageLines.push(buildMirrorLine(terminal, line));
  }

  const range = extractPiStickyInputMirrorRange(
    bottomPageLines.map((line) => line.plainText),
    terminal.cols,
  );
  if (!range) return null;

  return {
    lines: bottomPageLines.slice(range.startIndex, range.endIndex + 1),
  };
}

export function piStickyInputMirrorsEqual(
  left: PiStickyInputMirror | null,
  right: PiStickyInputMirror | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.lines.length !== right.lines.length) return false;

  for (let lineIndex = 0; lineIndex < left.lines.length; lineIndex += 1) {
    const leftLine = left.lines[lineIndex]!;
    const rightLine = right.lines[lineIndex]!;
    if (leftLine.plainText !== rightLine.plainText) return false;
    if (leftLine.segments.length !== rightLine.segments.length) return false;
    for (let segmentIndex = 0; segmentIndex < leftLine.segments.length; segmentIndex += 1) {
      const leftSegment = leftLine.segments[segmentIndex]!;
      const rightSegment = rightLine.segments[segmentIndex]!;
      if (leftSegment.text !== rightSegment.text) return false;
      if (leftSegment.styleKey !== rightSegment.styleKey) return false;
    }
  }

  return true;
}
