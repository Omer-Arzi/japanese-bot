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

### Standalone vs follow-up eval questions

Questions in `evals/questions.json` have a `type` field:

| Type | Meaning |
|---|---|
| `standalone` | Self-contained question — evaluated independently |
| `followup` | Context-dependent question that only makes sense after a previous answer (uses `dependsOn` to point to the prior question ID) |

Follow-up questions are run by injecting the previous question + answer as context into the prompt sent to `ask-sensei`. The critic applies three extra checks to follow-up answers:

| Check | What it catches |
|---|---|
| `followup-references-context` | Answer ignores the previous turn (reads like a cold restart) |
| `followup-not-generic` | "Why X?" answer describes X generically instead of explaining the prior response |
| `followup-no-uncertainty` | Uncertainty words (likely, probably) when explaining a prior known answer |

If the previous question failed or is unavailable, the follow-up is marked **SKIP** instead of FAIL — skipping context-dependent checks on incomplete data.

Follow-up questions in real chat logs (`logs/recent-chat-runs.json`) are auto-detected from short context-dependent phrases like "why?", "how so?", "why Lesson 10?". The `previousTurnId` field stores the timestamp of the preceding entry so `eval:recent` can look it up.

---

### Real chat logging

Every question asked via `ask-sensei` or the Tauri app is logged locally to `logs/recent-chat-runs.json` (max 10 entries, rolling). Interactions where the LLM server was offline are never logged. The file is git-ignored.

| Script | Description |
|---|---|
| `npm run eval:recent` | Run all critic checks against the 10 most recent real chat interactions. Saves report to `evals/runs/latest/recent_chat_critic_report.md`. |
| `npm run export:recent-for-claude` | Export the 10 recent interactions (+ critic results if already run) to `evals/runs/latest/recent_for_claude.md` for manual Claude Code review. |

**Typical workflow:**
```
npm run eval:recent                  # score real interactions
npm run export:recent-for-claude     # bundle for Claude Code review
# then: paste evals/runs/latest/recent_for_claude.md into Claude Code
```

---

### Indexing / Debug

| Script | Description |
|---|---|
| `npm run index:topics` | Rebuild the topic index (`data/topic-index.json`) from the current embeddings. Run after re-embedding or adding new chunks. |
| `npm run debug:topic` | Search the raw chunks for a specific topic. Useful for inspecting what the topic index sees before committing to a fix. |
