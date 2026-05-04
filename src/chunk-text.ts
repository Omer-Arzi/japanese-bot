import * as fs from "fs";
import * as path from "path";

const CHUNK_SIZE = 200;
const OVERLAP = 30;

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = start + CHUNK_SIZE;
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - OVERLAP;
  }

  return chunks;
}

function main() {
  const inputPath = path.join(process.cwd(), "data", "beginner-course-workbook.txt");

  if (!fs.existsSync(inputPath)) {
    console.error("Input file not found:", inputPath);
    process.exit(1);
  }

  const text = fs.readFileSync(inputPath, "utf-8");
  const chunkTexts = splitIntoChunks(text);

  const chunks = chunkTexts.map((chunkText, index) => ({
    id: `beginner-course-workbook-${index}`,
    source: "beginner-course-workbook.txt",
    chunkIndex: index,
    text: chunkText,
  }));

  const outputPath = path.join(process.cwd(), "data", "beginner-course-workbook.chunks.json");
  fs.writeFileSync(outputPath, JSON.stringify(chunks, null, 2), "utf-8");

  console.log(`Total chunks: ${chunks.length}`);
  console.log(`Saved to: ${outputPath}`);
}

main();
