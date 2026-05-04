import * as fs from "fs";
import * as path from "path";
import ollama from "ollama";

const EMBED_MODEL = "mxbai-embed-large";
const CHAT_MODEL = "qwen3:14b";

type QuestionMode = "practice" | "explanation" | "planning";
type Difficulty = "easy" | "medium" | "hard";

const MODE_KEYWORDS: Record<QuestionMode, string[]> = {
  practice:    ["practice", "drill", "exercise", "quiz", "write", "fill", "repeat", "תרגיל", "תרגול"],
  planning:    ["plan", "schedule", "syllabus"],
  explanation: ["explain", "what is", "how does", "meaning"],
};

const DIFFICULTY_KEYWORDS: Record<Difficulty, string[]> = {
  easy:   ["easy", "beginner", "basic", "simple", "קל"],
  hard:   ["hard", "difficult", "advanced", "challenge", "קשה"],
  medium: ["medium", "intermediate", "בינוני"],
};

const DIFFICULTY_INSTRUCTIONS: Record<Difficulty, string> = {
  easy: `Difficulty: EASY
- Use single hiragana characters only (e.g. あ, き, む)
- Questions should be straightforward romaji ↔ hiragana conversions`,

  medium: `Difficulty: MEDIUM
- Use short beginner words like かみ (kami), みず (mizu), ねこ (neko)
- Mix romaji → hiragana and hiragana → romaji question types`,

  hard: `Difficulty: HARD
- Use short phrases or sentences in hiragana
- Mix reading, writing, and sound-recognition tasks
- Can include simple particles like は, を, に`,
};

const MIX: Record<QuestionMode, Record<string, number>> = {
  practice:    { lesson: 3, vocab: 1, workbook: 4, genki: 0, unknown: 0 },
  explanation: { lesson: 5, vocab: 2, workbook: 1, genki: 0, unknown: 0 },
  planning:    { lesson: 4, vocab: 2, workbook: 2, genki: 0, unknown: 0 },
};

function detectMode(question: string): QuestionMode {
  const q = question.toLowerCase();
  for (const mode of ["practice", "planning", "explanation"] as QuestionMode[]) {
    if (MODE_KEYWORDS[mode].some((kw) => q.includes(kw))) return mode;
  }
  return "explanation";
}

function detectDifficulty(question: string): Difficulty {
  const q = question.toLowerCase();
  for (const level of ["easy", "hard", "medium"] as Difficulty[]) {
    if (DIFFICULTY_KEYWORDS[level].some((kw) => q.includes(kw))) return level;
  }
  return "medium";
}

function detectLanguage(question: string): "hebrew" | "english" {
  return /[֐-׿]/.test(question) ? "hebrew" : "english";
}

function detectLessonNumber(question: string): number | null {
  const match = question.match(/lesson\s*(\d+)/i);
  return match ? parseInt(match[1]!, 10) : null;
}

interface EmbeddedChunk {
  id: string;
  sourceFile: string;
  sourceType: string;
  lessonNumber: number | null;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

interface ScoredChunk {
  chunk: EmbeddedChunk;
  rawScore: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function pickTopN(ranked: ScoredChunk[], n: number): ScoredChunk[] {
  return ranked.slice(0, n);
}

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error("Usage: ts-node src/ask.ts <your question>");
    process.exit(1);
  }

  const embeddingsPath = path.join(process.cwd(), "data", "all-embeddings.json");
  if (!fs.existsSync(embeddingsPath)) {
    console.error("Embeddings file not found:", embeddingsPath);
    process.exit(1);
  }

  const chunks: EmbeddedChunk[] = JSON.parse(fs.readFileSync(embeddingsPath, "utf-8"));

  console.log("Creating question embedding...");
  const response = await ollama.embed({ model: EMBED_MODEL, input: question });
  const questionEmbedding = response.embeddings[0]!;

  const mode = detectMode(question);
  const difficulty = detectDifficulty(question);
  const lessonNumber = detectLessonNumber(question);
  const language = detectLanguage(question);

  // Score all chunks
  const allScored: ScoredChunk[] = chunks.map((chunk) => ({
    chunk,
    rawScore: cosineSimilarity(questionEmbedding, chunk.embedding),
  }));
  allScored.sort((a, b) => b.rawScore - a.rawScore);

  // Check if lesson filter applies
  const lessonChunks = lessonNumber !== null
    ? allScored.filter((s) => s.chunk.lessonNumber === lessonNumber)
    : [];
  const lessonFilterActive = lessonChunks.length >= 3;

  let selected: ScoredChunk[];

  if (lessonFilterActive && lessonNumber !== null) {
    // Use only chunks from the requested lesson
    selected = pickTopN(lessonChunks, 6);
  } else {
    // General retrieval: group by sourceType and apply mix
    const byType: Record<string, ScoredChunk[]> = {};
    for (const scored of allScored) {
      const t = scored.chunk.sourceType;
      if (!byType[t]) byType[t] = [];
      byType[t]!.push(scored);
    }
    const mix = MIX[mode];
    selected = [];
    for (const [sourceType, count] of Object.entries(mix)) {
      if (count === 0) continue;
      selected.push(...pickTopN(byType[sourceType] ?? [], count));
    }
  }

  // Print grouped by sourceType
  const grouped = selected.reduce<Record<string, ScoredChunk[]>>((acc, item) => {
    const t = item.chunk.sourceType;
    if (!acc[t]) acc[t] = [];
    acc[t]!.push(item);
    return acc;
  }, {});

  console.log(`\nMode: ${mode}  |  Difficulty: ${difficulty}  |  Language: ${language}${lessonNumber !== null ? `  |  Lesson: ${lessonNumber}` : ""}`);
  if (lessonFilterActive && lessonNumber !== null) {
    console.log(`Lesson filter applied: lesson ${lessonNumber} (${lessonChunks.length} chunks available)`);
  }
  console.log("\nSelected chunks:");
  for (const [sourceType, items] of Object.entries(grouped)) {
    console.log(`  [${sourceType}]`);
    for (const { chunk, rawScore } of items) {
      const lesson = chunk.lessonNumber !== null ? ` lesson ${chunk.lessonNumber}` : "";
      console.log(`    ${chunk.id}${lesson}  score: ${rawScore.toFixed(4)}`);
    }
  }

  const context = selected
    .map(({ chunk }) => `[${chunk.sourceType} / ${chunk.sourceFile}]\n${chunk.text}`)
    .join("\n\n---\n\n");

  const langInstruction = language === "hebrew" ? "You are a Japanese teacher. Answer in Hebrew." : "You are a Japanese teacher. Answer in English.";

  const practicePrompt = `${langInstruction} You are creating a practice drill.

${DIFFICULTY_INSTRUCTIONS[difficulty]}

Rules:
- Create exercises only. Do NOT explain grammar unless a question directly asks for it.
- Include exactly 10 questions.
- Include a clearly labeled answer key at the end with beginner-friendly explanations.
- Never mix scripts unless the user explicitly asks for it.
  - If the user asks for hiragana: use hiragana only. Do NOT introduce katakana.
  - If the user asks for katakana: use katakana only. Do NOT introduce hiragana.

For hiragana drills, only use these question types:
  1. Romaji → hiragana (e.g. "Write 'ka' in hiragana")
  2. Hiragana → romaji (e.g. "Read: き")
  3. Sound matching (e.g. "Which hiragana makes the sound 'su'?")
  4. Simple word reading in hiragana only

Never create meta-language questions like "X reads as katakana Y" or mix writing systems in a single question.
If the context is insufficient, still create exercises based on the topic in the question.
Never answer with unrelated topics.`;

  const systemPrompts: Record<QuestionMode, string> = {
    practice: practicePrompt,
    explanation: language === "hebrew"
      ? `${langInstruction}

אתה מורה יפנית ידידותי שמסביר למתחילים. כתוב בעברית תקנית ושוטפת.

חוקים מחייבים:
- עברית בלבד לטקסט ההסבר. אסור להשתמש בערבית או בכתבים אחרים.
- יפנית ורומאג'י מותרים רק בתוך הדוגמאות, בפורמט הקבוע.
- אל תפיק רשימות אוצר מילים אלא אם נשאלת במפורש.
- ענה רק על השאלה שנשאלה. אל תוסיף נושאים שלא בוקשו.

עיגון בחומר:
- השתמש רק במילים ובמבנים שמופיעים בהקשר שסופק.
- אל תמציא מילים יפניות שלא מופיעות בחומר.
- אם אינך בטוח, אל תשתמש במילה ספציפית.
- אם ההקשר אינו כולל דוגמה מלאה, כתוב: "החומר אינו כולל דוגמה מלאה לנושא זה"
  ואז הוסף דוגמה פשוטה ובטוחה, עם הערה: "(דוגמה שנוספה להסבר)"

פורמט חובה לכל דוגמה ביפנית (romaji באותיות קטנות בלבד):
  יפנית (romaji) — תרגום לעברית

מבנה התשובה:
  1. פסקת הסבר קצרה ובהירה
  2. שתיים עד שלוש דוגמאות בפורמט הנ"ל
  3. משפט סיכום אחד

כללי הסבר:
- השתמש בשפה טבעית ופעילה: "החלקיק מסמן..." ולא "מסומן על ידי".
- השתמש במילה "חלקיק" במקום "particle".
- תרגומים חייבים להיות מדויקים. העדף מילים קצרות וידועות.
- עבור חלקיקים: הסבר את התפקיד, את ההגייה אם שונה מהכתיב, והבדל בין נושא (topic) לסובייקט אם רלוונטי.

אם ההקשר אינו מספיק, ציין מה חסר ותסכם את מה שכן ידוע.`
      : `${langInstruction}

Answer using simple, beginner-friendly explanations. Do not overcomplicate or mislead.

Grounding rules:
- Use ONLY vocabulary and structures that appear in the provided context.
- Do NOT invent Japanese words or grammar patterns.
- If unsure about a word, avoid it.
- If the context lacks a full example, write: "The material does not include a full example for this topic."
  Then add a simple, safe example clearly labeled: "(example added for explanation)"

When showing Japanese, always use this format (romaji in lowercase only):
  Japanese (romaji) — translation

For particles like は: explain that it marks the topic and is pronounced "wa" when used as a particle.

Structure your answer:
  1. Short explanation paragraph
  2. 2–3 examples in the format above
  3. One summary sentence

If the context is incomplete, say what is missing but still summarize any relevant clues.`,
    planning: `${langInstruction} Create a structured learning plan using the provided context.
If the context is incomplete, say what is missing, but still provide a useful plan based on what is available.`,
  };

  const prompt = `${systemPrompts[mode]}

Context:
${context}

Question: ${question}`;

  console.log("\nAsking model...\n");
  const chat = await ollama.chat({
    model: CHAT_MODEL,
    messages: [{ role: "user", content: prompt }],
  });

  console.log("Answer:\n");
  console.log(chat.message.content);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
