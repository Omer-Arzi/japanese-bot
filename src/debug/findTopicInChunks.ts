import * as fs from "fs";
import * as path from "path";

const CHUNKS_PATH = path.join(process.cwd(), "data", "all-chunks.json");

const SEARCH_TERMS = [
  "te-form",
  "te form",
  "て-form",
  "て form",
  "て形",
  "食べて",
  "飲んで",
  "行って",
];

const CONTEXT_CHARS = 300;

interface Chunk {
  id: string;
  sourceFile: string;
  sourceType: string;
  lessonNumber: number | null;
  chunkIndex: number;
  text: string;
}

interface Match {
  chunkId: string;
  sourceFile: string;
  sourceType: string;
  lessonNumber: number | null;
  chunkIndex: number;
  term: string;
  matchIndex: number;
  before: string;
  matchText: string;
  after: string;
}

function findMatches(chunks: Chunk[]): Match[] {
  const results: Match[] = [];

  for (const chunk of chunks) {
    const textLower = chunk.text.toLowerCase();

    for (const term of SEARCH_TERMS) {
      const termLower = term.toLowerCase();
      let searchFrom = 0;

      while (true) {
        const idx = textLower.indexOf(termLower, searchFrom);
        if (idx === -1) break;

        results.push({
          chunkId:     chunk.id,
          sourceFile:  chunk.sourceFile,
          sourceType:  chunk.sourceType,
          lessonNumber: chunk.lessonNumber,
          chunkIndex:  chunk.chunkIndex,
          term,
          matchIndex:  idx,
          before:      chunk.text.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
          matchText:   chunk.text.slice(idx, idx + term.length),
          after:       chunk.text.slice(idx + term.length, idx + term.length + CONTEXT_CHARS),
        });

        searchFrom = idx + term.length;
      }
    }
  }

  return results;
}

function main() {
  if (!fs.existsSync(CHUNKS_PATH)) {
    console.error(`Chunks file not found: ${CHUNKS_PATH}`);
    process.exit(1);
  }

  const chunks: Chunk[] = JSON.parse(fs.readFileSync(CHUNKS_PATH, "utf-8"));
  console.log(`Loaded ${chunks.length} chunks from ${CHUNKS_PATH}\n`);

  const matches = findMatches(chunks);

  if (matches.length === 0) {
    console.log("No matches found for any search term.");
    console.log(`Terms searched: ${SEARCH_TERMS.join(", ")}`);
    return;
  }

  // Group by term for a summary first
  const byTerm: Record<string, Match[]> = {};
  for (const m of matches) {
    if (!byTerm[m.term]) byTerm[m.term] = [];
    byTerm[m.term]!.push(m);
  }

  console.log("=== SUMMARY ===\n");
  for (const term of SEARCH_TERMS) {
    const hits = byTerm[term] ?? [];
    if (hits.length === 0) {
      console.log(`  "${term}"  →  0 matches`);
    } else {
      const lessons = [...new Set(hits.map((h) => h.lessonNumber))].sort();
      const types   = [...new Set(hits.map((h) => h.sourceType))];
      console.log(`  "${term}"  →  ${hits.length} match(es)  |  lessons: [${lessons.join(", ")}]  |  sourceTypes: [${types.join(", ")}]`);
    }
  }

  console.log("\n=== FULL MATCHES ===\n");

  for (const term of SEARCH_TERMS) {
    const hits = byTerm[term] ?? [];
    if (hits.length === 0) continue;

    console.log(`${"─".repeat(70)}`);
    console.log(`TERM: "${term}"  (${hits.length} hit${hits.length === 1 ? "" : "s"})`);
    console.log(`${"─".repeat(70)}`);

    for (const m of hits) {
      console.log(`\n  chunk id    : ${m.chunkId}`);
      console.log(`  sourceType  : ${m.sourceType}`);
      console.log(`  sourceFile  : ${m.sourceFile}`);
      console.log(`  lessonNumber: ${m.lessonNumber ?? "(none)"}`);
      console.log(`  chunkIndex  : ${m.chunkIndex}`);
      console.log(`  match at    : char ${m.matchIndex}`);
      console.log(`\n  ···before···\n${m.before}`);
      console.log(`  >>>${m.matchText}<<<`);
      console.log(`  ···after···\n${m.after}`);
    }

    console.log();
  }

  console.log(`\nTotal: ${matches.length} match(es) across ${chunks.length} chunks.`);
}

main();
