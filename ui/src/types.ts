export type SidebarView = "chat" | "generate" | "outputs";

export type MessageRole = "user" | "assistant" | "error";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
}

export type Mode = "auto" | "explain" | "correct" | "analyze" | "practice";

export interface GeneratedFile {
  prompt: string;
  content: string;
  filePath?: string;
  timestamp: Date;
}
