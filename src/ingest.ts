import * as fs from "fs";
import * as path from "path";
import { PDFParse } from "pdf-parse";

const CHUNK_SIZE = 500;
const OVERLAP = 100;

type SourceType = "lesson" | "workbook" | "vocab" | "grammar" | "genki" | "unknown";

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
  const extractedDir = path.join(process.cwd(), "data", "extracted");
  const allChunksPath = path.join(process.cwd(), "data", "all-chunks.json");

  fs.mkdirSync(extractedDir, { recursive: true });

  const pdfs = findPdfs(docsDir);
  console.log(`Found ${pdfs.length} PDF(s)\n`);

  const allChunks: Chunk[] = [];

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

    // Save extracted text
    const txtName = relPath.replace(/[\\/]/g, "__").replace(/\.pdf$/i, ".txt");
    const txtPath = path.join(extractedDir, txtName);
    fs.writeFileSync(txtPath, text, "utf-8");
    console.log(`  Extracted ${text.length} chars → data/extracted/${txtName}`);

    // Chunk and collect
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
