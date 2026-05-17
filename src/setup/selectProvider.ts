import * as fs from "fs";
import * as path from "path";
import prompts from "prompts";
import type { LlmConfig } from "../llm/types";

const CONFIG_PATH = path.join(process.cwd(), ".local-llm-config.json");

const OLLAMA_MODELS = [
  "qwen3:14b",
  "qwen3:32b",
  "qwen3:8b",
  "qwen3:4b",
  "llama3.2:3b",
  "llama3.2:1b",
  "mistral",
  "gemma3:12b",
];

const VLLM_MODELS = [
  "qwen3:14b",
  "qwen3:32b",
  "meta-llama/Llama-3.2-3B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",
];

const DEFAULT_EMBED_MODEL = "mxbai-embed-large";

const DEFAULTS: Record<"ollama" | "vllm", Pick<LlmConfig, "baseUrl">> = {
  ollama: { baseUrl: "http://localhost:11434/v1" },
  vllm:   { baseUrl: "http://localhost:8000/v1"  },
};

function readConfig(): LlmConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as LlmConfig;
  } catch {
    return null;
  }
}

function saveConfig(cfg: LlmConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

function isValidModelName(value: string): boolean {
  const trimmed = value.trim();
  // Reject empty, pure numbers, or single characters that look like menu picks
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return true;
}

function abort(): never {
  console.log("\nSetup cancelled.\n");
  process.exit(0);
}

async function runSetup(): Promise<LlmConfig> {
  // ── Step 1: Provider ────────────────────────────────────────────────────────
  const { provider } = await prompts({
    type: "select",
    name: "provider",
    message: "Choose LLM provider",
    choices: [
      { title: "Ollama  (local, http://localhost:11434)", value: "ollama" },
      { title: "vLLM    (local, http://localhost:8000)",  value: "vllm"  },
    ],
    initial: 0,
  });
  if (!provider) abort();

  // ── Step 2: Model ────────────────────────────────────────────────────────────
  const modelChoices = provider === "vllm" ? VLLM_MODELS : OLLAMA_MODELS;
  const { modelChoice } = await prompts({
    type: "select",
    name: "modelChoice",
    message: "Choose chat model",
    choices: [
      ...modelChoices.map((m) => ({ title: m, value: m })),
      { title: "── Enter custom model name ──", value: "__custom__" },
    ],
    initial: 0,
  });
  if (!modelChoice) abort();

  let model: string = modelChoice;
  if (modelChoice === "__custom__") {
    const { customModel } = await prompts({
      type: "text",
      name: "customModel",
      message: "Model name",
      validate: (v: string) =>
        isValidModelName(v) ? true : "Enter a valid model name (e.g. qwen3:14b)",
    });
    if (!customModel) abort();
    model = customModel.trim();
  }

  // ── Step 3: Base URL ─────────────────────────────────────────────────────────
  const defaultUrl = DEFAULTS[provider as "ollama" | "vllm"].baseUrl;
  const { baseUrl } = await prompts({
    type: "text",
    name: "baseUrl",
    message: "Base URL",
    initial: defaultUrl,
    validate: (v: string) => (v.trim() ? true : "Base URL cannot be empty"),
  });
  if (!baseUrl) abort();

  return {
    provider: provider as "ollama" | "vllm",
    model,
    baseUrl: baseUrl.trim(),
    embedModel: DEFAULT_EMBED_MODEL,
  };
}

async function main(): Promise<void> {
  const existing = readConfig();

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       Japanese Agent — LLM Setup     ║");
  console.log("╚══════════════════════════════════════╝\n");

  if (existing) {
    const envOverride =
      process.env.LLM_PROVIDER || process.env.LLM_BASE_URL || process.env.LLM_MODEL;

    console.log(`Provider   : ${process.env.LLM_PROVIDER ?? existing.provider}`);
    console.log(`Base URL   : ${process.env.LLM_BASE_URL ?? existing.baseUrl}`);
    console.log(`Chat model : ${process.env.LLM_MODEL    ?? existing.model}`);
    console.log(`Embed model: ${existing.embedModel}`);
    if (envOverride) {
      console.log("\n⚠  Some values are overridden by environment variables.");
    }
    console.log("");

    const { keepConfig } = await prompts({
      type: "confirm",
      name: "keepConfig",
      message: "Keep this config?",
      initial: true,
    });

    // keepConfig is undefined if the user pressed Ctrl+C
    if (keepConfig === undefined) abort();
    if (keepConfig) {
      console.log("\nStarting Tauri...\n");
      return;
    }
  } else {
    console.log("No provider configured yet.\n");
  }

  const cfg = await runSetup();

  saveConfig(cfg);

  console.log(`\n✓ Saved to .local-llm-config.json`);
  console.log(`  Provider   : ${cfg.provider}`);
  console.log(`  Base URL   : ${cfg.baseUrl}`);
  console.log(`  Chat model : ${cfg.model}`);
  console.log("\nStarting Tauri...\n");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
