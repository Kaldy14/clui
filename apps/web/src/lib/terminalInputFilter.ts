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

const esc = String.fromCharCode(0x1b);
const bel = String.fromCharCode(7);
// OSC: ESC ] ... (ESC \ | BEL)  ·  CPR: ESC [ row ; col R
const TERMINAL_RESPONSE_RE = new RegExp(
  `${esc}\\][^${bel}${esc}]*(?:${esc}\\\\|${bel})|${esc}\\[\\d+;\\d+R`,
  "g",
);

/**
 * Strips terminal query responses from input data.
 * Returns the cleaned string, or empty string if everything was a response.
 */
export function stripTerminalResponses(data: string): string {
  return data.replace(TERMINAL_RESPONSE_RE, "");
}
