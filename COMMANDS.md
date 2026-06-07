# Project Commands

## CLI tools (bin/)

| Command | Usage | Description |
|---|---|---|
| `ask-sensei` | `ask-sensei "<question>"` | Ask the Japanese learning assistant a question. Detects mode (grammar explanation, lookup, curriculum) and answers from indexed course materials. |
| `sensei-file` | `sensei-file <path>` | Run the assistant against a file input instead of a typed question. |

---

## npm scripts

### UI / App

| Script | Description |
|---|---|
| `npm run ui:install` | Install dependencies for the Tauri UI (`ui/` directory). Run once after cloning. |
| `npm run ui:dev` | Start the Vite dev server for the UI frontend only (no Tauri shell). |
| `npm run tauri:dev` | Select an LLM provider, then launch the full Tauri desktop app in development mode. |
| `npm run tauri:build` | Build a production Tauri desktop app bundle. |

---

### Eval — running questions

| Script | Description |
|---|---|
| `npm run eval:sensei` | Run **all 36** eval questions through the model. Saves answers to `evals/runs/latest/answers.json`. Takes ~30 min. |
| `npm run eval:sensei:smoke` | Run only the **12 smoke** questions. Saves to `evals/runs/latest/smoke_answers.json`. Takes ~9 min. Use during active iteration. |

---

### Eval — scoring answers

| Script | Description |
|---|---|
| `npm run eval:critic` | Score the full answers file against all critic checks. Saves report to `evals/runs/latest/critic_report.md`. |
| `npm run eval:critic:smoke` | Score the smoke answers file. Saves to `evals/runs/latest/smoke_critic_report.md`. |

---

### Eval — repair workflow

| Script | Description |
|---|---|
| `npm run eval:fix-tasks` | Parse the full critic report and generate one repair task per failing check. Saves to `evals/runs/latest/fix_tasks.md`. |
| `npm run eval:smoke` | Full smoke pipeline: sensei → critic → fix-tasks → writes highest-priority task to `next_claude_task.md`. Use for quick iteration. |
| `npm run eval:repair:next` | Full pipeline (all 36 questions): sensei → critic → fix-tasks → writes highest-priority task to `next_claude_task.md`. Use before committing. |

**Typical workflow:**
```
npm run eval:smoke          # fast check while fixing
npm run eval:repair:next    # full check when done
# then: paste evals/runs/latest/next_claude_task.md into Claude Code
```

---

### Indexing / Debug

| Script | Description |
|---|---|
| `npm run index:topics` | Rebuild the topic index (`data/topic-index.json`) from the current embeddings. Run after re-embedding or adding new chunks. |
| `npm run debug:topic` | Search the raw chunks for a specific topic. Useful for inspecting what the topic index sees before committing to a fix. |
