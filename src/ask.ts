import * as fs from "fs";
import * as path from "path";
import ollama from "ollama";

const EMBED_MODEL = "mxbai-embed-large";
const CHAT_MODEL = "qwen3:14b";

// ─── Types ────────────────────────────────────────────────────────────────────

type QuestionMode = "practice" | "explanation" | "planning";
type GrammarIntent = "explanation" | "analysis" | "correction" | "general";
type Difficulty = "easy" | "medium" | "hard";

// ─── Detection keywords ───────────────────────────────────────────────────────

const MODE_KEYWORDS: Record<QuestionMode, string[]> = {
  practice:    ["practice", "drill", "exercise", "quiz", "write", "fill", "repeat", "תרגיל", "תרגול"],
  planning:    ["plan", "schedule", "syllabus"],
  explanation: ["explain", "what is", "how does", "meaning"],
};

const INTENT_KEYWORDS: Record<GrammarIntent, string[]> = {
  correction: [
    "is this correct", "is it correct", "fix this", "correct this",
    "does this make sense", "is this natural",
    "זה נכון", "זה תקין", "תתקן", "נשמע טבעי", "האם זה נכון",
  ],
  analysis: [
    "break down", "analyze", "parse",
    "תנתח", "פרק", "פירוק משפט",
  ],
  explanation: [
    "explain", "what is", "difference", "why", "how does",
    "תסביר", "מה זה", "מה ההבדל", "למה", "איך",
  ],
  general: [],
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

// ─── Output cleanup ───────────────────────────────────────────────────────────

const COMMAND_LINE_RE = /^\s*(ask-sensei|sensei-file|ts-node|npx|node)\b.*/i;
const QUOTED_COMMAND_RE = /`[^`]*ask-sensei[^`]*`/gi;

// Arabic U+0600–U+06FF, Cyrillic U+0400–U+04FF, Korean Hangul U+AC00–U+D7AF + Jamo
const ARABIC_RE = /[؀-ۿ]/g;
const CYRILLIC_RE = /[Ѐ-ӿ]/g;
const KOREAN_RE = /[가-힯ᄀ-ᇿ㄰-㆏]/g;

// Remove duplicated adjacent Hebrew words: "נושא (נושא)" → "נושא"
const HEBREW_WORD_RE = /[א-תיִ-פֿ]+/;
const DUPLICATE_PARENS_RE = new RegExp(
  `(${HEBREW_WORD_RE.source})\\s*\\(\\1\\)`,
  "gu",
);

// Detect Hebrew and Japanese characters
const HAS_HEBREW_RE = /[א-ת]/;
const HAS_JAPANESE_RE = /[぀-ヿ㐀-䶿一-鿿]/;

// A Latin token looks like Japanese romaji if it follows CV syllable structure.
// Rejects patterns like "uur", "burg" that have non-Japanese consonant sequences.
const ROMAJI_RE = /^(?:(?:sh|ch|ts|[kgsztnhbpmrywdjfv])?[aeiou]{1,2})+n?$/i;

// On pure Hebrew text lines (no Japanese chars, no "—" separator),
// remove any Latin word of 3+ characters that doesn't look like romaji.
function stripStrayLatin(line: string): string {
  if (!HAS_HEBREW_RE.test(line) || HAS_JAPANESE_RE.test(line)) return line;
  if (line.includes("—") || line.includes("—")) return line;
  return line
    .replace(/\b[a-zA-Z]{3,}\b/g, (word) => (ROMAJI_RE.test(word) ? word : ""))
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanOutput(text: string): string {
  return text
    .split("\n")
    // Remove CLI command lines
    .filter((line) => !COMMAND_LINE_RE.test(line))
    // Strip Arabic and Cyrillic characters from each line
    .map((line) => line.replace(ARABIC_RE, "").replace(CYRILLIC_RE, "").replace(KOREAN_RE, ""))
    // Strip stray non-romaji Latin words from Hebrew text lines
    .map(stripStrayLatin)
    // Remove lines that became empty or whitespace-only after stripping
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .replace(QUOTED_COMMAND_RE, "")
    // Remove duplicated Hebrew word in parentheses: "נושא (נושא)" → "נושא"
    .replace(DUPLICATE_PARENS_RE, "$1")
    // Collapse excess blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Global grammar rules injected into every prompt ─────────────────────────

const OUTPUT_RULES = `
Output rules — always follow these:
- Never include CLI commands, terminal examples, or shell invocations in the answer.
- Never repeat or quote the user's question in the output.
- Return only the answer content itself.
`;

const GRAMMAR_ACCURACY_RULES = `
Critical grammar rules — never violate these:
- は marks the TOPIC (pronounced "wa" as a particle). NOT the subject in the grammatical sense.
- が marks the SUBJECT, or focus, or the liked thing with すき/suki/嫌い.
- を marks the DIRECT OBJECT.
- に marks direction, destination, time, or indirect object.
- で marks location of action or means.
- て-form is a VERB FORM, not a particle.
- Never claim が marks the object. Never claim を marks the subject.
- Do not mix Arabic script or unrelated writing systems into explanations.
- For Japanese examples, use: Japanese (romaji) — translation
`;

const HEBREW_BASE_RULES = `
כללי שפה עברית — חובה לפעול לפיהם:
- כתוב עברית תקנית, שוטפת וטבעית. אל תתרגם מילולית מאנגלית.
- ההסבר חייב להיות עברית בלבד. אסור לערבב כתב ערבי, קירילי, או אנגלית פנימה.
- אל תערבב אותיות עבריות עם רומאג'י בתוך אותה מילה.
  שגוי: "אני watashi מדבר"
  נכון: "אני (watashi) מדבר"
- אסור לכתוב מילה ואחריה אותה מילה בסוגריים: שגוי: "נושא (נושא)". נכון: "נושא".
- דוגמאות ביפנית: כתוב את הדוגמה ביפנית / רומאג'י, ואחריה תרגום עברי.
  פורמט: יפנית (romaji) — תרגום עברי
- אל תשתמש באנגלית אלא אם אין מונח עברי מקובל.

עברית טבעית — דוגמאות:
  שגוי: "מיקום (למשל)"
  נכון: "המקום שבו מתבצעת הפעולה"

  שגוי: "object ישיר"
  נכון: "מושא ישיר"

  שגוי: "particle של נושא"
  נכון: "חלקיק נושא"

  שגוי: "ב פעולה" (עם רווח)
  נכון: "בפעולה" (ללא רווח — ב' היא קידומת דבוקה)

- אל תשתמש במילת-כותרת בקוריאנית (כמו 예시). השתמש רק בעברית: "דוגמאות", "הסבר", "סיכום".

תרגומים נכונים — חובה להשתמש בהם:
  東京 / Toukyou → טוקיו (לא "טאיקו")
  会議 / kaigi → פגישה (לא "meeting")
  好き / suki → אוהב / חובב (לא "Thing you like")
  学校 / gakkou → בית ספר
  電車 / densha → רכבת
  ありがとう / arigatou → תודה
  すみません / sumimasen → סליחה / רגע בבקשה

כללי דקדוק יפני — אסור לטעות:
- は = מסמן נושא השיח. מבוטא "wa" כחלקיק.
- が = נושא דקדוקי / הדגשה / קיום.
  עם すき (suki — לאהוב / לחבב): הדבר האהוב מסומן ב-が, לא ב-を.
  הסיבה: すき הוא כמו שם תואר ביפנית, לא פועל. לכן הדבר האהוב הוא ה"נושא" שעליו מדברים.
  דוגמה: 猫が好きです (neko ga suki desu) — "אני אוהב חתולים"
- を = מושא ישיר (של פועל פעולה).
- に = יעד, זמן, מיקום סטטי (איפה משהו נמצא), מושא עקיף.
- で = המקום שבו מתבצעת פעולה, או האמצעי שבו משתמשים.
  הבחנה חשובה — תמיד הסבר עם זוג דוגמאות מנוגדות:
    東京にいます (toukyou ni imasu) — "אני נמצא בטוקיו" [מיקום סטטי — に]
    東京で働きます (toukyou de hatarakimasu) — "אני עובד בטוקיו" [מקום ביצוע פעולה — で]
- צורת て היא צורת פועל — לא חלקיק.
- אל תטען ש-が מסמן מושא. אל תטען ש-を מסמן נושא.

נכונות פעלים — דוגמאות נכונות:
  hatarakimasu (לעבוד) — לא "atsukite"
  kakimasu (לכתוב) — לא "kaku masu"
  tabemasu (לאכול) — לא "tabe masu"
  ikimasu (ללכת) — לא "iku masu"
`;

// ─── Detection functions ──────────────────────────────────────────────────────

function detectIntent(question: string): GrammarIntent {
  const q = question.toLowerCase();
  for (const intent of ["correction", "analysis", "explanation"] as GrammarIntent[]) {
    if (INTENT_KEYWORDS[intent].some((kw) => q.includes(kw))) return intent;
  }
  return "general";
}

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

// ─── Embeddings / retrieval ───────────────────────────────────────────────────

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

// ─── System prompts ───────────────────────────────────────────────────────────

function buildSystemPrompt(
  intent: GrammarIntent,
  mode: QuestionMode,
  difficulty: Difficulty,
  language: "hebrew" | "english",
): string {
  const lang = language === "hebrew"
    ? "You are a Japanese teacher. Answer in Hebrew."
    : "You are a Japanese teacher. Answer in English.";

  const base     = `${OUTPUT_RULES}${GRAMMAR_ACCURACY_RULES}`;
  const hebrewBase = `${OUTPUT_RULES}${HEBREW_BASE_RULES}`;

  if (intent === "explanation") {
    if (language === "hebrew") {
      return `${lang}
${hebrewBase}
אתה מורה דקדוק יפני ידידותי למתחילים.

חוקים:
- אל תפיק רשימות אוצר מילים אלא אם נשאלת במפורש.
- ענה רק על השאלה שנשאלה.
- אם ההקשר מספק מידע רלוונטי — השתמש בו.
- עבור נושאי דקדוק בסיסיים — תמיד תן הסבר מלא מידיעתך, גם אם ההקשר חלקי.
- אין לכתוב "החומר אינו כולל..." — הסבר את הנושא ישירות.

נושאים שמותר תמיד להסביר (גם ללא הקשר):
  חלקיקים: は, が, を, に, で, へ, も, と, の
  צורות פועל: ます, て, עבר, שלילי
  מבנה משפט בסיסי, ברכות, מספרים

ציין את סוג הנושא: חלקיק / צורת פועל / תבנית משפט / אחר.

מבנה התשובה:
  1. הסבר פשוט וברור
  2. 2–3 דוגמאות בפורמט: יפנית (romaji) — תרגום
  3. סיכום קצר

שפה טבעית ופעילה: "החלקיק מסמן..." ולא "מסומן על ידי".
השתמש במילה "חלקיק" במקום "particle".`;
    }
    return `${lang}
${base}
You are a beginner-friendly Japanese grammar tutor.

Rules:
- Explain clearly and accurately.
- Use general Japanese knowledge for core grammar even if retrieved context is incomplete.
- Clearly state whether the topic is a particle, verb form, sentence pattern, etc.
- Keep it beginner-friendly — no advanced grammar unless asked.
- NEVER write "The material does not include..." — just explain the topic.

Topics you may always explain regardless of context:
  Particles: は, が, を, に, で, へ, も, と, の
  Verb forms: ます, て-form, past tense, negative
  Basic sentence structure, greetings, numbers

Format for Japanese examples (romaji in lowercase):
  Japanese (romaji) — translation

Structure:
  1. Short explanation paragraph
  2. 2–3 examples
  3. One summary sentence`;
  }

  if (intent === "analysis") {
    if (language === "hebrew") {
      return `${lang}
${hebrewBase}
אתה מנתח משפטים יפניים למתחילים.

נתח את המשפט שהמשתמש נותן.

פורמט הפלט:
  משפט: ...
  פירוק:
  - מילה / ביטוי → תפקיד דקדוקי
  תרגום: ...
  הסבר קצר: ...

שמור על פשטות ודיוק. אל תשתמש במונחים מתקדמים.`;
    }
    return `${lang}
${base}
You are a beginner-friendly Japanese sentence analyst.

Analyze the sentence given by the user.

Output format:
  1. Sentence
  2. Breakdown: word/phrase → grammar role
  3. Translation
  4. Short explanation

Keep it simple and accurate. Avoid advanced terminology.`;
  }

  if (intent === "correction") {
    if (language === "hebrew") {
      return `${lang}
${hebrewBase}
אתה בודק דקדוק יפני.

בהינתן משפט יפני (ברומאג'י, הירגנה, קטקנה או מעורב):
  1. אמור אם המשפט תקין או לא תקין.
  2. אם לא תקין — תן גרסה מתוקנת, בטוחה ופשוטה.
  3. הסבר את התיקון בקצרה.
  4. אם המשפט מובן אך לא טבעי — סמן "כמעט תקין".

כללים:
- תקן חלקיקים: は, が, を, に, で
- תקן צורות פועל בסיסיות
- תקן משפטים לא טבעיים למתחילים
- העדף יפנית פשוטה ונכונה על פני תיקונים מתקדמים
- אם יש כמה אפשרויות תיקון, תן את הגרסה הבטוחה והפשוטה ביותר
- השתמש בהקשר שסופק כתמיכה אם רלוונטי, אבל אל תסרב לתקן בגלל חוסר בהקשר

פורמט פלט:
  סטטוס: תקין / לא תקין / כמעט תקין
  תיקון: ...
  הסבר: ...`;
    }
    return `${lang}
${base}
You are a Japanese grammar checker.

Given a Japanese sentence in romaji, hiragana, katakana, or mixed Japanese:
  1. Say if it is correct or incorrect.
  2. If incorrect, provide a corrected beginner-safe version.
  3. Explain the correction briefly.

Rules:
- Fix particles: は, が, を, に, で
- Fix basic verb forms
- Fix unnatural beginner sentences
- Prefer simple correct Japanese over advanced corrections
- If there are multiple possible corrections, give the safest beginner version
- Use retrieved context as support but do not refuse to correct because context is incomplete

Output format:
  Status: Correct / Incorrect / Mostly correct
  Corrected: ...
  Explanation: ...`;
  }

  // General intent — and also practice/planning modes fall through here
  if (mode === "practice") {
    return `${lang}
${base}
You are creating a practice drill.

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
  }

  if (mode === "planning") {
    return `${lang}
${base}
Create a structured learning plan using the provided context.
If the context is incomplete, still provide a useful plan based on what is available.`;
  }

  // General Q&A
  if (language === "hebrew") {
    return `${lang}
${hebrewBase}
אתה מורה יפנית ידידותי. ענה על השאלה בעברית בצורה ברורה ומועילה.
- אם ההקשר מספק מידע — השתמש בו. אחרת, ענה מידיעתך כמורה.`;
  }
  return `${lang}
${base}
You are a helpful Japanese teacher. Answer the question clearly.
Use the retrieved context when relevant. For basic Japanese topics, answer from your knowledge as a teacher.`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

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

  const intent     = detectIntent(question);
  const mode       = detectMode(question);
  const difficulty = detectDifficulty(question);
  const lessonNumber = detectLessonNumber(question);
  const language   = detectLanguage(question);

  // Score all chunks
  const allScored: ScoredChunk[] = chunks.map((chunk) => ({
    chunk,
    rawScore: cosineSimilarity(questionEmbedding, chunk.embedding),
  }));
  allScored.sort((a, b) => b.rawScore - a.rawScore);

  // Lesson filter
  const lessonChunks = lessonNumber !== null
    ? allScored.filter((s) => s.chunk.lessonNumber === lessonNumber)
    : [];
  const lessonFilterActive = lessonChunks.length >= 3;

  let selected: ScoredChunk[];

  if (lessonFilterActive && lessonNumber !== null) {
    selected = pickTopN(lessonChunks, 6);
  } else {
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

  // Print diagnostics
  const grouped = selected.reduce<Record<string, ScoredChunk[]>>((acc, item) => {
    const t = item.chunk.sourceType;
    if (!acc[t]) acc[t] = [];
    acc[t]!.push(item);
    return acc;
  }, {});

  console.log(
    `\nMode: ${mode}  |  Intent: ${intent}  |  Difficulty: ${difficulty}  |  Language: ${language}` +
    (lessonNumber !== null ? `  |  Lesson: ${lessonNumber}` : ""),
  );
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

  const systemPrompt = buildSystemPrompt(intent, mode, difficulty, language);

  const prompt = `${systemPrompt}

Context:
${context}

Question: ${question}`;

  console.log("\nAsking model...\n");
  const chat = await ollama.chat({
    model: CHAT_MODEL,
    messages: [{ role: "user", content: prompt }],
  });

  console.log("Answer:\n");
  console.log(cleanOutput(chat.message.content));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
