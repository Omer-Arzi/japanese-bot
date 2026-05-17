# Japanese Agent

A local RAG-based Japanese learning assistant. Indexes your learning materials and answers questions, generates exercises, and creates study files — all running locally with no external API calls.

---

## Prerequisites

- Node.js 18+
- [Ollama](https://ollama.com) or a vLLM server

---

## Setup

```bash
npm install
```

---

## LLM Provider

The agent supports two local LLM providers. Provider selection is stored in `.local-llm-config.json` (git-ignored, machine-specific).

### First run

On the first run of any command that calls the model, you will be prompted:

```
No LLM provider configured. Choose one:
  1. Ollama (default)
  2. vLLM

Enter 1 or 2 [1]:
```

Press Enter to accept Ollama. Your choice is saved to `.local-llm-config.json`.

### Using Ollama

1. Install Ollama: https://ollama.com
2. Pull the required models:
   ```bash
   ollama pull qwen3:14b
   ollama pull mxbai-embed-large
   ```
3. Ollama runs at `http://localhost:11434` by default. No extra config needed.

### Using vLLM

1. Start a vLLM server with an OpenAI-compatible endpoint:
   ```bash
   vllm serve qwen3:14b --host 0.0.0.0 --port 8000
   ```
2. On first run, choose option `2` when prompted, or set the env var:
   ```bash
   LLM_PROVIDER=vllm npm run ask:sensei "..."
   ```

### Changing provider

Delete or edit `.local-llm-config.json` in the project root:

```bash
rm .local-llm-config.json   # triggers first-run prompt again
```

Or edit it directly — copy `.local-llm-config.example.json` as a starting point.

### Environment variable overrides

Env vars take priority over `.local-llm-config.json`:

| Variable        | Description                          | Example                          |
|-----------------|--------------------------------------|----------------------------------|
| `LLM_PROVIDER`  | `ollama` or `vllm`                   | `LLM_PROVIDER=vllm`              |
| `LLM_BASE_URL`  | Base URL of the OpenAI-compatible API | `LLM_BASE_URL=http://localhost:8000/v1` |
| `LLM_MODEL`     | Chat model name                      | `LLM_MODEL=qwen3:32b`            |
| `LLM_API_KEY`   | API key (optional, for auth)         | `LLM_API_KEY=sk-...`             |

Priority: `env vars` > `.local-llm-config.json` > built-in defaults.

### Local-only files

These files are git-ignored and must not be committed:

| File                      | Purpose                              |
|---------------------------|--------------------------------------|
| `.local-llm-config.json`  | Your local provider/model selection  |

Use `.local-llm-config.example.json` as a reference for the format.

---

## Commands

```bash
# Ask the sensei a question
npm run ask:sensei "What is the difference between は and が?"

# Generate a study file
npm run sensei-file "Create a vocabulary worksheet for lesson 3"

# Ingest/re-index learning materials
npm run ingest

# Embed all chunks
npm run embed

# Run the eval suite
npm run eval:sensei     # generates evals/runs/latest/answers.json
npm run eval:critic     # generates evals/runs/latest/critic_report.md
npm run eval:fix-tasks  # generates evals/runs/latest/fix_tasks.md
```

---

## Architecture

```
ask.ts / create-file.ts / embed-all.ts
        ↓
    llm/LlmService       (facade — single import point)
        ↓
    llm/config           (reads .local-llm-config.json + env vars)
        ↓
    OllamaProvider  or  VllmProvider
        ↓
    Ollama API      or  OpenAI-compatible HTTP
```

Business logic never imports from `ollama` directly. All model calls go through `llm` from `src/llm/LlmService.ts`.
