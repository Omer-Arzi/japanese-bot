// Direct access to the Tauri IPC bridge — avoids @tauri-apps/api version issues.
import { STRINGS } from "../constants/strings";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: unknown) => Promise<T>;
    };
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!window.__TAURI_INTERNALS__) {
    throw new Error(STRINGS.errors.notInTauri);
  }
  return window.__TAURI_INTERNALS__.invoke<T>(cmd, args ?? {});
}
