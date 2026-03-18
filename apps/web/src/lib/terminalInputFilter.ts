/**
 * Filters out terminal query responses from xterm.js onData before
 * forwarding to the PTY. Without this, responses to queries like
 * OSC 11 (background color) and DSR/CPR (cursor position) leak
 * back into the PTY and appear as visible garbage text.
 *
 * Matched sequences:
 *  - OSC responses:  ESC ] <params> ST   (ST = ESC \ or BEL)
 *  - CPR responses:  ESC [ <row> ; <col> R
 */

// OSC: \x1b] ... (\x1b\\ | \x07)
// CPR: \x1b[ digits ; digits R
const TERMINAL_RESPONSE_RE =
  /\x1b\][^\x07\x1b]*(?:\x1b\\|\x07)|\x1b\[\d+;\d+R/g;

/**
 * Strips terminal query responses from input data.
 * Returns the cleaned string, or empty string if everything was a response.
 */
export function stripTerminalResponses(data: string): string {
  return data.replace(TERMINAL_RESPONSE_RE, "");
}
