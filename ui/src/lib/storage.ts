import { Message, GeneratedFile } from "../types";

const KEYS = {
  messages: "sensei:messages",
  files: "sensei:files",
} as const;

const LIMITS = {
  messages: 50,
  files: 4,
} as const;

function reviveDate<T extends { timestamp: string | Date }>(
  item: T,
): T & { timestamp: Date } {
  return { ...item, timestamp: new Date(item.timestamp) };
}

export function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(KEYS.messages);
    if (!raw) return [];
    return (JSON.parse(raw) as Message[]).map(reviveDate);
  } catch {
    return [];
  }
}

export function saveMessages(messages: Message[]): void {
  try {
    localStorage.setItem(
      KEYS.messages,
      JSON.stringify(messages.slice(-LIMITS.messages)),
    );
  } catch {
    // Silently ignore storage errors (e.g. private mode)
  }
}

export function loadFiles(): GeneratedFile[] {
  try {
    const raw = localStorage.getItem(KEYS.files);
    if (!raw) return [];
    return (JSON.parse(raw) as GeneratedFile[]).map(reviveDate);
  } catch {
    return [];
  }
}

export function saveFiles(files: GeneratedFile[]): void {
  try {
    localStorage.setItem(
      KEYS.files,
      JSON.stringify(files.slice(0, LIMITS.files)),
    );
  } catch {}
}

export function clearStorage(): void {
  try {
    localStorage.removeItem(KEYS.messages);
    localStorage.removeItem(KEYS.files);
  } catch {}
}
