import { useState } from "react";
import { invoke } from "../lib/invoke";

export interface FileGenResult {
  output: string;
  file_path?: string;
}

export function useFileGen() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(prompt: string): Promise<FileGenResult | null> {
    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<FileGenResult>("run_sensei_file", { prompt });
      return result;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setIsLoading(false);
    }
  }

  return { isLoading, error, generate };
}
