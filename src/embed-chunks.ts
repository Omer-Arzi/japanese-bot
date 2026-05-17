import * as fs from "fs";
import * as path from "path";
import { llm } from "./llm/LlmService";

interface Chunk {
  id: string;
  source: string;
  chunkIndex: number;
  text: string;
}

interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

async function main() {
  const inputPath = path.join(process.cwd(), "data", "beginner-course-workbook.chunks.json");

  if (!fs.existsSync(inputPath)) {
    console.error("Input file not found:", inputPath);
    process.exit(1);
  }

  const chunks: Chunk[] = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const total = chunks.length;
  const results: EmbeddedChunk[] = [];

  for (let i = 0; i < total; i++) {
    const chunk = chunks[i];
    console.log(`Embedding ${i + 1}/${total}`);

    const response = { embedding: await llm.embed(chunk!.text) };

    results.push({
      id: chunk!.id,
      source: chunk!.source,
      chunkIndex: chunk!.chunkIndex,
      text: chunk!.text,
      embedding: response.embedding,
    });
  }

  const outputPath = path.join(process.cwd(), "data", "beginner-course-workbook.embeddings.json");
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");

  console.log(`\nDone. Saved ${results.length} embeddings to: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
