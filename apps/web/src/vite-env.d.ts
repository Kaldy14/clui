/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge } from "@clui/contracts";

declare global {
  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
  }
}
