const TERMINAL_CONTROL_SEQUENCE_RE =
  /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\x1b\\|[@-Z\\-_])/g;
const NON_PRINTING_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const PI_WORKING_STATUS_RE = /\r[^\r\n]{0,80}\bWorking(?:\.{3,4}|…)/;

export function stripPiTerminalControls(data: string): string {
  return data.replace(TERMINAL_CONTROL_SEQUENCE_RE, "").replace(NON_PRINTING_CONTROL_RE, "");
}

export function hasVisiblePiOutput(data: string): boolean {
  return stripPiTerminalControls(data).trim().length > 0;
}

export function hasPiWorkingStatusOutput(data: string): boolean {
  return PI_WORKING_STATUS_RE.test(stripPiTerminalControls(data));
}
