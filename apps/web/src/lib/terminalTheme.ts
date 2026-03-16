import type { ITheme } from "@xterm/xterm";
import { type TerminalColorTheme, getAppSettingsSnapshot } from "../appSettings";

/** Named dark-mode ANSI palettes. Each returns a full ITheme for dark mode. */
const DARK_THEMES: Record<TerminalColorTheme, () => ITheme> = {
  "muted-earth": () => ({
    background: "#0c0c0c",
    foreground: "#ebebeb",
    cursor: "#8a9a7b",
    cursorAccent: "#0c0c0c",
    selectionBackground: "rgba(138, 154, 123, 0.25)",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.08)",
    scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.14)",
    scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.18)",
    black: "#1a1a1a",
    red: "#b05050",
    green: "#7d9968",
    yellow: "#c4a55a",
    blue: "#6b8ba4",
    magenta: "#9b7098",
    cyan: "#6d9a9a",
    white: "#b0b0b0",
    brightBlack: "#3a3a3a",
    brightRed: "#c47070",
    brightGreen: "#98b880",
    brightYellow: "#d4b870",
    brightBlue: "#85a5be",
    brightMagenta: "#b58ab2",
    brightCyan: "#88b4b4",
    brightWhite: "#d8d8d8",
  }),
  "classic-pastel": () => {
    const bodyStyles = getComputedStyle(document.body);
    const background =
      bodyStyles.backgroundColor || "rgb(14, 18, 24)";
    const foreground = bodyStyles.color || "rgb(237, 241, 247)";
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  },
};

/** Named light-mode ANSI palettes. */
const LIGHT_THEMES: Record<TerminalColorTheme, () => ITheme> = {
  "muted-earth": () => {
    const bodyStyles = getComputedStyle(document.body);
    const background = bodyStyles.backgroundColor || "rgb(255, 255, 255)";
    const foreground = bodyStyles.color || "rgb(28, 33, 41)";
    return {
      background,
      foreground,
      cursor: "#5a6b4e",
      selectionBackground: "rgba(90, 107, 78, 0.18)",
      scrollbarSliderBackground: "rgba(0, 0, 0, 0.12)",
      scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.22)",
      scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.28)",
      black: "rgb(44, 53, 66)",
      red: "#8b3a3a",
      green: "#4d6b3a",
      yellow: "#7a6530",
      blue: "#3f5f78",
      magenta: "#6b4566",
      cyan: "#3f6b6b",
      white: "rgb(210, 215, 223)",
      brightBlack: "rgb(112, 123, 140)",
      brightRed: "#a04a4a",
      brightGreen: "#5d7d4a",
      brightYellow: "#8a753a",
      brightBlue: "#4f6f8a",
      brightMagenta: "#7b5576",
      brightCyan: "#4f7b7b",
      brightWhite: "rgb(236, 240, 246)",
    };
  },
  "classic-pastel": () => {
    const bodyStyles = getComputedStyle(document.body);
    const background = bodyStyles.backgroundColor || "rgb(255, 255, 255)";
    const foreground = bodyStyles.color || "rgb(28, 33, 41)";
    return {
      background,
      foreground,
      cursor: "rgb(38, 56, 78)",
      selectionBackground: "rgba(37, 63, 99, 0.2)",
      scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
      scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
      scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
      black: "rgb(44, 53, 66)",
      red: "rgb(191, 70, 87)",
      green: "rgb(60, 126, 86)",
      yellow: "rgb(146, 112, 35)",
      blue: "rgb(72, 102, 163)",
      magenta: "rgb(132, 86, 149)",
      cyan: "rgb(53, 127, 141)",
      white: "rgb(210, 215, 223)",
      brightBlack: "rgb(112, 123, 140)",
      brightRed: "rgb(212, 95, 112)",
      brightGreen: "rgb(85, 148, 111)",
      brightYellow: "rgb(173, 133, 45)",
      brightBlue: "rgb(91, 124, 194)",
      brightMagenta: "rgb(153, 107, 172)",
      brightCyan: "rgb(70, 149, 164)",
      brightWhite: "rgb(236, 240, 246)",
    };
  },
};

/**
 * Derives an xterm.js theme from the current app appearance (light/dark mode)
 * and the user's selected terminal color theme.
 *
 * Shared by all terminal surfaces: Claude session terminals, shell drawer
 * terminals, and project terminals. Changes to the palette apply everywhere.
 */
export function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const settings = getAppSettingsSnapshot();
  const themeName = settings.terminalColorTheme as TerminalColorTheme;
  const themeMap = isDark ? DARK_THEMES : LIGHT_THEMES;
  const factory = themeMap[themeName] ?? themeMap["muted-earth"];
  return factory();
}
