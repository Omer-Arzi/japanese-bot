# Japanese Agent Project

## Project goal

This project is a local Japanese-learning assistant.

The goal is to build a local RAG-based system that can read and index Japanese learning materials, then help generate:

1. A table of contents / topic map for the uploaded learning materials.
2. A learning syllabus for a group of 4 friends who already know basic Japanese.
3. Vocabulary-focused exercises.
4. Answer sheets for the exercises.
5. Later, PDF exports.
6. Later, a local UI, probably with Tauri.

## Important concept

Ollama models do not permanently learn the PDFs.

The system should use RAG:
- extract text from PDFs
- split text into chunks
- create embeddings
- store them in a local vector database
- retrieve relevant chunks
- send those chunks to the LLM through Ollama

The same indexed knowledge base should be shared by all agents.

## Current materials

The docs folder contains:

1. Genki 1 PDF  
   This appears to be image/scanned-based and may require OCR later.

2. חוברת קורס מתחילים.pdf  
   This is a Hebrew beginner Japanese course workbook. Text extraction seems possible.

3. まるごと 入門 語彙.pdf  
   This is a Marugoto A1 vocabulary wordbook organized by topic.

For now, do not get blocked by Genki OCR. Start with the two PDFs that can be text-extracted.

## Current stage

We are at Stage 1.

Stage 1 goal:
- create a Node.js + TypeScript project
- read PDFs from the docs folder
- extract text
- print a preview
- later save extracted text into data/

Do not implement embeddings yet unless explicitly asked.

## Preferred stack

- Node.js
- TypeScript
- Ollama
- pdf-parse for initial PDF extraction
- later: ChromaDB or another local vector DB
- later: mxbai-embed-large for embeddings through Ollama
- later: qwen3:32b for deep reasoning
- later: qwen3:14b or qwen3:8b for faster tasks

## Development style

Work step by step.

Do not create the full system at once.

Before making big changes:
1. Explain the plan briefly.
2. Create or edit only the necessary files.
3. Give commands to run.
4. Wait for the result.

Prefer simple, readable TypeScript.

Avoid over-engineering.

## First task

Help me create a script:

src/read-pdf.ts

It should:
- read docs/חוברת קורס מתחילים.pdf
- use pdf-parse
- print number of pages
- print text length
- print the first 2000 characters
- handle missing file errors clearly