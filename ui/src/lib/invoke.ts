// Direct access to the Tauri IPC bridge — avoids @tauri-apps/api version issues.

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
    throw new Error(
      "Not running inside the Tauri window.\n" +
        "Start the app with:\n  npm run tauri:dev\n\n" +
        "Do not open localhost:5173 directly in a browser.",
    );
  }
  return window.__TAURI_INTERNALS__.invoke<T>(cmd, args ?? {});
}
