import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type { LlmConfig } from "./types";

const CONFIG_PATH = path.join(process.cwd(), ".local-llm-config.json");

const DEFAULTS: Record<"ollama" | "vllm", LlmConfig> = {
  ollama: {
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:14b",
    embedModel: "mxbai-embed-large",
  },
  vllm: {
    provider: "vllm",
    baseUrl: "http://localhost:8000/v1",
    model: "qwen3:14b",
    embedModel: "mxbai-embed-large",
  },
};

function readEnvOverrides(): Partial<LlmConfig> {
  const overrides: Partial<LlmConfig> = {};
  if (process.env.LLM_PROVIDER === "ollama" || process.env.LLM_PROVIDER === "vllm") {
    overrides.provider = process.env.LLM_PROVIDER;
  }
  if (process.env.LLM_BASE_URL) overrides.baseUrl = process.env.LLM_BASE_URL;
  if (process.env.LLM_MODEL)    overrides.model    = process.env.LLM_MODEL;
  if (process.env.LLM_API_KEY)  overrides.apiKey   = process.env.LLM_API_KEY;
  return overrides;
}

function readLocalConfig(): LlmConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as LlmConfig;
  } catch {
    return null;
  }
}

async function promptFirstRun(): Promise<LlmConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve) => {
    rl.question(
      "\nNo LLM provider configured. Choose one:\n  1. Ollama (default)\n  2. vLLM\n\nEnter 1 or 2 [1]: ",
      (answer) => {
        rl.close();
        const cfg: LlmConfig =
          answer.trim() === "2" ? { ...DEFAULTS.vllm } : { ...DEFAULTS.ollama };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
        process.stderr.write(`\nSaved to .local-llm-config.json (git-ignored).\n\n`);
        resolve(cfg);
      },
    );
  });
}

let cached: LlmConfig | null = null;

export async function loadConfig(): Promise<LlmConfig> {
  if (cached) return cached;

  const local = readLocalConfig();
  const base: LlmConfig = local ?? (await promptFirstRun());
  const env = readEnvOverrides();

  // Priority: env vars > local config > first-run defaults
  cached = {
    provider:   env.provider   ?? base.provider,
    baseUrl:    env.baseUrl    ?? base.baseUrl,
    model:      env.model      ?? base.model,
    embedModel: base.embedModel ?? "mxbai-embed-large",
    apiKey:     env.apiKey     ?? base.apiKey,
  };

  return cached;
}
