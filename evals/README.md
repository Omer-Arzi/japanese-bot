# Sensei Eval System

## Overview

The eval system checks that the `ask-sensei` agent answers Japanese learning questions correctly.
It runs questions through the model, then a rule-based critic scores the answers.

## Files

```
evals/
  questions.json              — full eval question bank (do not auto-edit)
  smoke-ids.json              — IDs included in the smoke suite
  runs/
    latest/
      answers.json            — raw model answers from the last full eval run
      critic_report.md        — per-question pass/fail (full suite)
      fix_tasks.md            — all failed checks as repair tasks (full suite)
      smoke_answers.json      — raw model answers from the last smoke eval run
      smoke_critic_report.md  — per-question pass/fail (smoke suite)
      smoke_fix_tasks.md      — failed checks from smoke run
      next_claude_task.md     — highest-priority task (written by eval:repair:next or eval:smoke)
```

## Scripts

| Script | What it does |
|---|---|
| `npm run eval:sensei` | Runs **all** 36 questions → `answers.json` |
| `npm run eval:sensei:smoke` | Runs the **12 smoke** questions → `smoke_answers.json` |
| `npm run eval:critic` | Scores `answers.json` → `critic_report.md` |
| `npm run eval:critic:smoke` | Scores `smoke_answers.json` → `smoke_critic_report.md` |
| `npm run eval:fix-tasks` | Parses `critic_report.md` → `fix_tasks.md` |
| `npm run eval:smoke` | smoke sensei + smoke critic + fix-tasks → `next_claude_task.md` |
| `npm run eval:repair:next` | Full sensei + critic + fix-tasks → `next_claude_task.md` |

## When to use smoke vs full

| Situation | Use |
|---|---|
| Quick sanity check after a focused fix | `eval:smoke` (~5 min) |
| After touching routing logic, lookup patterns, or critic checks | `eval:smoke` first, then `eval:repair:next` to confirm |
| Before committing or opening a PR | `eval:repair:next` (full suite) |
| A fix affects only one or two known questions | `eval:smoke` is likely sufficient |
| Adding new eval questions | `eval:repair:next` to baseline everything |

**Smoke suite covers:** particles, te-form exception, adjective classification, particle を, te-form pattern, lesson-number lookup, topic index (te-form lesson, na-adjectives), verb group exception, ある/いる, すき particle, materials-coverage lookup.

## Repair workflow

```
npm run eval:smoke          # fast iteration during a fix
npm run eval:repair:next    # full check before done
```

The `eval:smoke` entry point:

1. Runs eval:sensei:smoke (12 questions only).
2. Runs eval:critic:smoke.
3. Runs eval:fix-tasks (smoke mode).
4. Selects the highest-priority task, writes `next_claude_task.md`.

`eval:repair:next` does the same with the full 36-question suite.

**You review and approve every change.** Neither script edits `src/` files automatically.

## Priority order

Tasks are selected in this order:

1. **Infrastructure / run errors** — empty answers, placeholder text, run crashes
2. **Lookup / routing errors** — question routed to wrong mode, lookup returns nothing
3. **Factual Japanese errors** — wrong verb form, wrong particle, wrong adjective class
4. **Romaji errors** — incorrect romanization
5. **Style / overconfidence** — "always", "never", overly strong phrasing

## Adding eval questions

Edit `evals/questions.json`. Each entry needs:

```json
{ "id": "q24", "topic": "short-topic-slug", "question": "Your question here." }
```

Use the next sequential ID. Do not change existing question IDs or text — the critic
report and fix tasks reference them by ID.

## Adding a new critic check

1. Add the check function to `src/eval/critic.ts`.
2. Call it inside `runChecks()`.
3. Add the check name → files mapping to `filesForCheck()` in `src/eval/generateFixTasks.ts`.
4. Add a priority entry in `CHECK_PRIORITY` in `src/eval/repairNext.ts`.
