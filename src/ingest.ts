import * as fs from "fs";
import * as path from "path";
import { PDFParse } from "pdf-parse";

const CHUNK_SIZE = 500;
const OVERLAP = 100;

type SourceType = "summary" | "lesson" | "workbook" | "vocab" | "grammar" | "genki" | "unknown";

interface Chunk {
  id: string;
  sourceFile: string;
  sourceType: SourceType;
  lessonNumber: number | null;
  chunkIndex: number;
  text: string;
}

function getSourceType(relPath: string): SourceType {
  const p = relPath.replace(/\\/g, "/");
  const folder = p.split("/")[0]?.toLowerCase() ?? "";

  if (folder === "classes-summary") return "summary";
  if (folder === "lessons") return "lesson";
  if (folder === "workbooks") return "workbook";
  if (folder === "vocab") return "vocab";
  if (folder === "grammar") return "grammar";
  if (folder === "genki" || p.toLowerCase().includes("genki")) return "genki";
  return folder as SourceType || "unknown";
}

function getLessonNumber(relPath: string): number | null {
  const match = path.basename(relPath).match(/lesson-(\d+)/i);
  return match ? parseInt(match[1]!, 10) : null;
}

function findPdfs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPdfs(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      results.push(full);
    }
  }
  return results;
}

function findMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => path.join(dir, e.name));
}

// Chunk a markdown file by its level-1 (#) headings.
// Each heading and its content becomes one chunk.
// If a section is large, split further on level-2 (##) headings.
function chunkMarkdown(text: string): string[] {
  // Strip YAML frontmatter (--- ... ---)
  const body = text.replace(/^---[\s\S]*?---\n?/, "").trim();

  // Split on lines that start a new level-1 heading
  const level1 = body.split(/(?=^# )/m).filter((s) => s.trim().length > 0);

  const chunks: string[] = [];
  for (const section of level1) {
    if (section.length <= 1200) {
      chunks.push(section.trim());
    } else {
      // Section is large — split on level-2 headings, keeping the # title as context
      const title = section.match(/^(# [^\n]+)/)?.[1] ?? "";
      const subsections = section.split(/(?=^## )/m).filter((s) => s.trim().length > 0);
      for (const sub of subsections) {
        const prefixed = sub.startsWith("## ") ? `${title}\n${sub.trim()}` : sub.trim();
        chunks.push(prefixed);
      }
    }
  }

  return chunks.filter((c) => c.length > 20);
}

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE - OVERLAP;
  }
  return chunks;
}

async function extractText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

async function main() {
  const docsDir = path.join(process.cwd(), "docs");
  const summaryDir = path.join(docsDir, "classes-summary");
  const extractedDir = path.join(process.cwd(), "data", "extracted");
  const allChunksPath = path.join(process.cwd(), "data", "all-chunks.json");

  fs.mkdirSync(extractedDir, { recursive: true });

  const allChunks: Chunk[] = [];

  // ── 1. Class summaries (markdown, primary source) ─────────────────────────
  const mdFiles = findMarkdownFiles(summaryDir);
  console.log(`Found ${mdFiles.length} summary file(s) in docs/classes-summary/\n`);

  for (const absPath of mdFiles) {
    const relPath = path.relative(docsDir, absPath);
    const baseName = path.basename(relPath, ".md");
    const lessonNumber = getLessonNumber(relPath);
    const text = fs.readFileSync(absPath, "utf-8");
    const chunkTexts = chunkMarkdown(text);

    chunkTexts.forEach((chunkText, index) => {
      allChunks.push({
        id: `${baseName}-${index}`,
        sourceFile: relPath,
        sourceType: "summary",
        lessonNumber,
        chunkIndex: index,
        text: chunkText,
      });
    });

    console.log(`  [summary] ${relPath} → ${chunkTexts.length} chunks`);
  }

  // ── 2. PDFs (secondary source — noisy but broader coverage) ───────────────
  const pdfs = findPdfs(docsDir);
  console.log(`\nFound ${pdfs.length} PDF(s)\n`);

  for (const absPath of pdfs) {
    const relPath = path.relative(docsDir, absPath);
    console.log(`Processing: ${relPath}`);

    let text: string;
    try {
      text = await extractText(absPath);
    } catch (err) {
      console.warn(`  Skipped (extraction failed): ${err}`);
      continue;
    }

    const txtName = relPath.replace(/[\\/]/g, "__").replace(/\.pdf$/i, ".txt");
    const txtPath = path.join(extractedDir, txtName);
    fs.writeFileSync(txtPath, text, "utf-8");
    console.log(`  Extracted ${text.length} chars → data/extracted/${txtName}`);

    const sourceType = getSourceType(relPath);
    const lessonNumber = getLessonNumber(relPath);
    const baseName = path.basename(relPath, ".pdf");
    const chunkTexts = splitIntoChunks(text);

    chunkTexts.forEach((chunkText, index) => {
      allChunks.push({
        id: `${baseName}-${index}`,
        sourceFile: relPath,
        sourceType,
        lessonNumber,
        chunkIndex: index,
        text: chunkText,
      });
    });

    console.log(`  Created ${chunkTexts.length} chunks`);
  }

  fs.writeFileSync(allChunksPath, JSON.stringify(allChunks, null, 2), "utf-8");
  console.log(`\nTotal chunks: ${allChunks.length}`);
  console.log(`Saved to: ${allChunksPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
