import * as fs from "fs";
import * as path from "path";
import { llm } from "./llm/LlmService";
const FALLBACK_CHUNK_SIZE = 250;
const FALLBACK_OVERLAP = 50;

interface Chunk {
  id: string;
  sourceFile: string;
  sourceType: string;
  lessonNumber: number | null;
  chunkIndex: number;
  text: string;
}

interface EmbeddedChunk {
  id: string;
  parentChunkId: string | null;
  sourceFile: string;
  sourceType: string;
  lessonNumber: number | null;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

function splitIntoSubchunks(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    parts.push(text.slice(start, start + FALLBACK_CHUNK_SIZE));
    start += FALLBACK_CHUNK_SIZE - FALLBACK_OVERLAP;
  }
  return parts;
}

function isContextLengthError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("input length exceeds the context length");
}

async function main() {
  const inputPath = path.join(process.cwd(), "data", "all-chunks.json");
  const outputPath = path.join(process.cwd(), "data", "all-embeddings.json");

  if (!fs.existsSync(inputPath)) {
    console.error("Input file not found:", inputPath);
    process.exit(1);
  }

  const chunks: Chunk[] = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const total = chunks.length;
  const results: EmbeddedChunk[] = [];
  const failed: string[] = [];

  for (let i = 0; i < total; i++) {
    const chunk = chunks[i]!;
    process.stdout.write(`Embedding ${i + 1}/${total}\r`);

    try {
      const embedding = await llm.embed(chunk.text);
      results.push({
        id: chunk.id,
        parentChunkId: null,
        sourceFile: chunk.sourceFile,
        sourceType: chunk.sourceType,
        lessonNumber: chunk.lessonNumber,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        embedding,
      });
    } catch (err) {
      if (!isContextLengthError(err)) {
        console.warn(`\nSkipped chunk ${chunk.id} (unexpected error): ${err}`);
        failed.push(chunk.id);
        continue;
      }

      // Fallback: split into subchunks and embed each one
      const subchunks = splitIntoSubchunks(chunk.text);
      let allSubchunksOk = true;

      for (let j = 0; j < subchunks.length; j++) {
        try {
          const subEmbedding = await llm.embed(subchunks[j]!);
          results.push({
            id: `${chunk.id}__part-${j + 1}`,
            parentChunkId: chunk.id,
            sourceFile: chunk.sourceFile,
            sourceType: chunk.sourceType,
            lessonNumber: chunk.lessonNumber,
            chunkIndex: chunk.chunkIndex,
            text: subchunks[j]!,
            embedding: subEmbedding,
          });
        } catch (subErr) {
          console.warn(`\nFailed subchunk ${chunk.id}__part-${j + 1}: ${subErr}`);
          allSubchunksOk = false;
        }
      }

      if (!allSubchunksOk) failed.push(chunk.id);
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");

  console.log(`\nTotal original chunks : ${total}`);
  console.log(`Total embedded items  : ${results.length}`);
  console.log(`Failed chunks         : ${failed.length}${failed.length > 0 ? " → " + failed.join(", ") : ""}`);
  console.log(`Saved to              : ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
