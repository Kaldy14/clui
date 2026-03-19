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
      selectionBackground: "rgba(70, 110, 180, 0.22)",
      scrollbarSliderBackground: "rgba(0, 0, 0, 0.12)",
      scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.22)",
      scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.28)",
      black: "rgb(44, 53, 66)",
      red: "#c25050",
      green: "#4a8c4a",
      yellow: "#a08520",
      blue: "#4878b0",
      magenta: "#8855a0",
      cyan: "#3a8888",
      white: "rgb(210, 215, 223)",
      brightBlack: "rgb(112, 123, 140)",
      brightRed: "#dd7070",
      brightGreen: "#6db86d",
      brightYellow: "#c4a530",
      brightBlue: "#6898cc",
      brightMagenta: "#a878b8",
      brightCyan: "#58acac",
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
      selectionBackground: "rgba(50, 80, 160, 0.22)",
      scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
      scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
      scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
      black: "rgb(44, 53, 66)",
      red: "rgb(205, 85, 100)",
      green: "rgb(75, 150, 100)",
      yellow: "rgb(170, 135, 40)",
      blue: "rgb(85, 120, 185)",
      magenta: "rgb(150, 100, 165)",
      cyan: "rgb(60, 148, 160)",
      white: "rgb(210, 215, 223)",
      brightBlack: "rgb(112, 123, 140)",
      brightRed: "rgb(225, 115, 130)",
      brightGreen: "rgb(100, 175, 125)",
      brightYellow: "rgb(195, 155, 55)",
      brightBlue: "rgb(110, 145, 210)",
      brightMagenta: "rgb(170, 125, 190)",
      brightCyan: "rgb(80, 170, 185)",
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
