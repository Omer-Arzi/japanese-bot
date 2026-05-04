import * as fs from "fs";
import * as path from "path";
import ollama from "ollama";

const EMBED_MODEL = "mxbai-embed-large";
const CHAT_MODEL = "qwen3:14b";
const EMBEDDINGS_PATH = path.join(process.cwd(), "data", "all-embeddings.json");
const OUTPUT_DIR = path.join(process.cwd(), "output");
const EXERCISE_BANK_PATH = path.join(process.cwd(), "data", "exercise-bank.json");

interface ExerciseEntry {
  id: string;
  type: string;
  question: string;
  answer: string;
  lesson: number | null;
  difficulty: string;
  source: "generated";
  createdAt: number;
}


function appendToExerciseBank(entries: ExerciseEntry[]): void {
  let existing: ExerciseEntry[] = [];
  if (fs.existsSync(EXERCISE_BANK_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(EXERCISE_BANK_PATH, "utf-8"));
    } catch {
      existing = [];
    }
  }
  fs.writeFileSync(
    EXERCISE_BANK_PATH,
    JSON.stringify([...existing, ...entries], null, 2),
    "utf-8"
  );
  console.log(`  Exercise bank: appended ${entries.length} entries → ${EXERCISE_BANK_PATH}`);
}

function loadExerciseBank(): ExerciseEntry[] {
  if (!fs.existsSync(EXERCISE_BANK_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(EXERCISE_BANK_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/[.?!,]+$/, "").replace(/\s+/g, " ");
}

function pickRelevantExercises(
  bank: ExerciseEntry[],
  difficulty: WorksheetDifficulty,
  lesson: number | null,
  count: number,
  exclude: Set<string>
): ExerciseEntry[] {
  const scored = bank
    .filter((e) => !exclude.has(normalizeQuestion(e.question)))
    .map((e) => {
      let score = 0;
      if (e.difficulty === difficulty) score += 2;
      if (lesson !== null && e.lesson === lesson) score += 3;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.e);
}

function formatNumberedList(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function parseNumberedList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]/.test(l))
    .map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 0);
}

function makeEntries(
  questions: string[],
  answers: string[],
  exerciseType: string,
  difficulty: string,
  lesson: number | null
): ExerciseEntry[] {
  const now = Date.now();
  return questions
    .map((q, i) => ({
      id: `ex-${now}-${i}`,
      type: exerciseType,
      question: q,
      answer: answers[i] ?? "",
      lesson,
      difficulty,
      source: "generated" as const,
      createdAt: now,
    }))
    .filter((e) => e.question.length > 0);
}

interface WorkbookQuestion {
  prompt: string;
  answer: string;
}

interface WorkbookSection {
  id: string;
  title: string;
  instructions: string;
  questions: WorkbookQuestion[];
}

function parseMultipleChoiceBlock(raw: string, n: number): Array<{ q: string; opts: string }> {
  const result: Array<{ q: string; opts: string }> = [];
  const lines = stripModelArtifacts(raw).split("\n").filter((l) => l.trim());
  let i = 0;
  while (i < lines.length && result.length < n) {
    const line = lines[i]!.trim();
    if (/^\d+[.)]/.test(line)) {
      const q = line.replace(/^\d+[.)]\s*/, "").trim();
      const next = lines[i + 1]?.trim() ?? "";
      const hasOpts = /\bA\)/i.test(next) && /\bB\)/i.test(next);
      result.push({ q, opts: hasOpts ? next : "" });
      i += hasOpts ? 2 : 1;
    } else {
      i++;
    }
  }
  return result;
}

function validateSectionQuestions(qs: WorkbookQuestion[], n: number): string | null {
  if (qs.length < Math.max(1, n - 2)) return `too few: ${qs.length}/${n}`;
  if (qs.some((q) => !q.prompt.trim())) return "empty prompt";
  if (qs.some((q) => !q.answer.trim())) return "empty answer";
  const seen = new Set<string>();
  for (const q of qs) {
    const norm = normalizeQuestion(q.prompt);
    if (seen.has(norm)) return "duplicate";
    seen.add(norm);
  }
  return null;
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
  score: number;
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function parseArgs(): { prompt: string; outName: string | null } {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  let outName: string | null = null;
  let promptArgs = args;

  if (outIndex !== -1) {
    outName = args[outIndex + 1] ?? null;
    promptArgs = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  }

  return { prompt: promptArgs.join(" ").trim(), outName };
}

function isFullWorkbookRequest(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return p.includes("workbook") ||
    p.includes("comprehensive") ||
    p.includes("multiple exercise types") ||
    p.includes("חוברת");
}

function isPracticeFileRequest(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return p.includes("worksheet") ||
    p.includes("practice") ||
    p.includes("exercise") ||
    p.includes("test") ||
    p.includes("translation") ||
    p.includes("translate");
}

function isPerLessonPractice(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return isPracticeFileRequest(p) && (
    p.includes("per lesson") ||
    p.includes("for each lesson") ||
    p.includes("each lesson") ||
    p.includes("for every lesson") ||
    p.includes("לכל שיעור")
  );
}

function isPerLessonRequest(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return !isPracticeFileRequest(p) && (
    p.includes("for each lesson") ||
    p.includes("per lesson") ||
    p.includes("each lesson") ||
    p.includes("לכל שיעור")
  );
}

function wantsExamples(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return p.includes("example") || p.includes("דוגמ");
}

function wantsAnswerKey(prompt: string): boolean {
  const p = prompt.toLowerCase();
  // Default true for any practice/worksheet prompt; false only if explicitly denied
  if (isPracticeFileRequest(p)) return true;
  return p.includes("answer key") || p.includes("answer") || p.includes("answers") ||
    p.includes("מפתח") || p.includes("תשובות") || p.includes("תשובה");
}

function extractCount(prompt: string, defaultCount = 5): number {
  const match = prompt.match(/\b(\d+)\s*(sentences?|questions?|items?|משפטים?|שאלות?)/i);
  return match ? parseInt(match[1]!, 10) : defaultCount;
}

function extractExerciseType(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes("fill in the blank") || p.includes("fill in")) return "fill-in-the-blank";
  if (p.includes("multiple choice")) return "multiple-choice";
  if (p.includes("translation") || p.includes("translate")) return "translation";
  if (p.includes("matching")) return "matching";
  return "translation";
}

function extractOutputLanguage(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes("hebrew") || p.includes("עברית") || /לעברית/.test(p)) return "Hebrew";
  if (p.includes("english") || p.includes("אנגלית")) return "English";
  return "Hebrew";
}

type WorksheetDifficulty = "easy" | "medium" | "hard" | "default";

function detectWorksheetDifficulty(prompt: string): WorksheetDifficulty {
  const p = prompt.toLowerCase();
  if (p.includes("easy") || p.includes("beginner") || p.includes("simple") || p.includes("קל")) return "easy";
  if (p.includes("hard") || p.includes("difficult") || p.includes("advanced") || p.includes("קשה")) return "hard";
  if (p.includes("medium") || p.includes("intermediate") || p.includes("בינוני")) return "medium";
  return "default";
}

const DIVERSITY_RULES = `Diversity rules (apply to ALL difficulty levels):
- Maximum 2 sentences of the form "X wa Y desu". Do not fill the list with this pattern.
- Do NOT repeat the same subject (e.g. "watashi") in more than 2 sentences.
- Do NOT repeat the same sentence structure more than twice.
- For every 5 sentences, include at least:
  - 1 verb sentence (e.g. tabemasu, ikimasu, mimasu, nomimasu)
  - 1 sentence using wo (direct object, e.g. "gohan wo tabemasu")
  - 1 sentence using ni or de (location, direction, or time)
  - 1 question sentence ending in "ka"
- Vary subjects: use watashi, anata, kare, kanojo, tomodachi, sensei, etc.
- Vary topics across: people, food, places, school, daily activities.
- Each sentence should add one extra element (location, time, object, or person).`;

const DIFFICULTY_PROMPTS: Record<WorksheetDifficulty, string> = {
  easy: `Difficulty: EASY
- Sentence length: 2–4 words.
- Mostly "X wa Y desu" pattern is ok, but still include at least 1 verb sentence and 1 question.
- No complex verbs. Keep particles minimal (wa, ga only).

${DIVERSITY_RULES}`,

  medium: `Difficulty: MEDIUM
- Sentence length: 5–8 words.
- Use action verbs: tabemasu, mimasu, ikimasu, nomimasu, yomimasu, kaimasu.
- Include particles: wa, wo, ni, de.
- Include at least one question (ending in "ka") and one negative (ending in "masen").
- Avoid te-form chains. Basic te-form requests are ok (e.g. "tabete kudasai").

${DIVERSITY_RULES}`,

  hard: `Difficulty: HARD
- Sentence length: 8–12 words.
- Chain ideas using te-form where natural (e.g. "koohii wo nonde, hon wo yomimasu").
- Use a variety of particles and verb forms.
- Include question, negative, and request sentences.
- Stay within N5-level grammar.

${DIVERSITY_RULES}`,

  default: `Difficulty: MIXED (not specified)
- Mix sentence lengths: short (3–5 words) and medium (5–8 words).
- Mix topics freely from all available lessons.
- Include declarative, question, and negative sentences.
- Use particles: wa, ga, wo, ni, de.
- Include common verbs: ikimasu, tabemasu, nomimasu, mimasu, yomimasu.

${DIVERSITY_RULES}`,
};

// Common N5-level fallback vocabulary if context is sparse.
const N5_FALLBACK_VOCAB = [
  "watashi", "anata", "kare", "kanojo", "sensei", "tomodachi",
  "inu", "neko", "hon", "mizu", "gohan", "pan", "kuruma", "ie",
  "gakkou", "shigoto", "suki", "kirai", "ii", "warui",
  "taberu", "nomu", "iku", "kuru", "miru", "kaku", "yomu", "hanasu",
  "ookii", "chiisai", "atarashii", "furui", "takai", "yasui",
  "kyou", "ashita", "kinou", "ima", "asa", "ban",
  "hai", "iie", "arigatou", "sumimasen", "wakaru", "shiru",
];

const BEGINNER_SAFE_RULES = `N5 level only:
- No irasshaimasu, nasaimasu, koto ga dekimasu, te iru/aru, ba conditionals.
- Allowed verbs: tabemasu, nomimasu, ikimasu, kimasu, mimasu, yomimasu, kakimasu, hanashimasu, kaimasu, nemasu, arimasu, imasu, kaerimasu, benkyou shimasu.
- Particles: wa, ga, wo, ni, de only.
- Sentence endings: desu, masu, masen, desu ka, masu ka.`;

const FALLBACK_WQ: Record<string, WorkbookQuestion[]> = {
  translation: [
    { prompt: "watashi wa gakusei desu.", answer: "אני תלמיד/ה." },
    { prompt: "kore wa hon desu.", answer: "זה ספר." },
    { prompt: "kyou wa ii tenki desu.", answer: "היום מזג האוויר טוב." },
    { prompt: "neko ga imasu.", answer: "יש חתול." },
    { prompt: "watashi wa gohan wo tabemasu.", answer: "אני אוכל/ת אורז." },
    { prompt: "tomodachi wa gakkou ni ikimasu.", answer: "החבר/ה הולך/ת לבית ספר." },
    { prompt: "kare wa mizu wo nomimasu.", answer: "הוא שותה מים." },
    { prompt: "hon wo yomimasu ka.", answer: "האם אתה/את קורא/ת ספר?" },
    { prompt: "watashi wa nihongo wo benkyou shimasu.", answer: "אני לומד/ת יפנית." },
    { prompt: "inu wa ie ni imasu.", answer: "הכלב בבית." },
  ],
  reverse: [
    { prompt: "אני תלמיד/ה.", answer: "watashi wa gakusei desu." },
    { prompt: "זה ספר.", answer: "kore wa hon desu." },
    { prompt: "היום מזג האוויר טוב.", answer: "kyou wa ii tenki desu." },
    { prompt: "יש חתול.", answer: "neko ga imasu." },
    { prompt: "אני אוכל/ת אורז.", answer: "watashi wa gohan wo tabemasu." },
    { prompt: "החבר/ה הולך/ת לבית ספר.", answer: "tomodachi wa gakkou ni ikimasu." },
    { prompt: "הוא שותה מים.", answer: "kare wa mizu wo nomimasu." },
    { prompt: "האם אתה/את קורא/ת ספר?", answer: "hon wo yomimasu ka." },
    { prompt: "אני לומד/ת יפנית.", answer: "watashi wa nihongo wo benkyou shimasu." },
    { prompt: "הכלב בבית.", answer: "inu wa ie ni imasu." },
  ],
  fillblank: [
    { prompt: "watashi wa ___ wo tabemasu.", answer: "gohan" },
    { prompt: "kore wa watashi no ___ desu.", answer: "hon" },
    { prompt: "tomodachi wa ___ ni ikimasu.", answer: "gakkou" },
    { prompt: "kare wa mizu wo ___.", answer: "nomimasu" },
    { prompt: "neko wa ___ ni imasu.", answer: "ie" },
    { prompt: "watashi wa ___ desu.", answer: "gakusei" },
    { prompt: "hon wa tsukue no ___ ni arimasu.", answer: "ue" },
    { prompt: "kyou wa ___ tenki desu.", answer: "ii" },
    { prompt: "watashi wa nihongo wo ___ shimasu.", answer: "benkyou" },
    { prompt: "kare wa kaisha ___ hataraimasu.", answer: "de" },
  ],
  multiplechoice: [
    { prompt: "watashi wa gakkou ___ ikimasu.\nA) wo  B) ni  C) de", answer: "B) ni" },
    { prompt: "hon ___ yomimasu.\nA) wo  B) wa  C) ni", answer: "A) wo" },
    { prompt: "gakkou ___ nihongo wo hanashimasu.\nA) ni  B) ga  C) de", answer: "C) de" },
    { prompt: "watashi ___ gakusei desu.\nA) ga  B) wa  C) wo", answer: "B) wa" },
    { prompt: "neko ___ imasu.\nA) wo  B) ga  C) wa", answer: "B) ga" },
    { prompt: "koohii ___ nomimasu.\nA) ni  B) de  C) wo", answer: "C) wo" },
    { prompt: "tomodachi wa gakkou ___ kimashita.\nA) wo  B) ni  C) de", answer: "B) ni" },
    { prompt: "watashi wa nihongo ___ benkyou shimasu.\nA) wo  B) ni  C) ga", answer: "A) wo" },
    { prompt: "kare wa ie ___ kaerimasu.\nA) ni  B) wo  C) de", answer: "A) ni" },
    { prompt: "inu wa kouen ___ asonde imasu.\nA) ga  B) wo  C) de", answer: "C) de" },
  ],
  sentencebuilding: [
    { prompt: "wa / watashi / desu / gakusei", answer: "watashi wa gakusei desu." },
    { prompt: "tabemasu / wa / gohan / watashi / wo", answer: "watashi wa gohan wo tabemasu." },
    { prompt: "ikimasu / gakkou / ni / tomodachi / wa", answer: "tomodachi wa gakkou ni ikimasu." },
    { prompt: "hon / yomimasu / wo / kare / wa", answer: "kare wa hon wo yomimasu." },
    { prompt: "nomimasu / wo / mizu / kanojo / wa", answer: "kanojo wa mizu wo nomimasu." },
    { prompt: "benkyou / nihongo / wo / shimasu / watashi / wa", answer: "watashi wa nihongo wo benkyou shimasu." },
    { prompt: "imasu / neko / ie / ni / ga", answer: "ie ni neko ga imasu." },
    { prompt: "ii / tenki / kyou / wa / desu", answer: "kyou wa ii tenki desu." },
    { prompt: "kaerimasu / ie / ni / haha / wa", answer: "haha wa ie ni kaerimasu." },
    { prompt: "mimasu / terebi / wo / ban / watashi / wa", answer: "watashi wa ban ni terebi wo mimasu." },
  ],
  errorcorrection: [
    { prompt: "watashi wa gakkou ni tabemasu.", answer: "watashi wa gakkou de tabemasu." },
    { prompt: "kare wa mizu ni nomimasu.", answer: "kare wa mizu wo nomimasu." },
    { prompt: "gakkou de ikimasu.", answer: "gakkou ni ikimasu." },
    { prompt: "watashi ga gakusei desu.", answer: "watashi wa gakusei desu." },
    { prompt: "tomodachi wo gakkou ni imasu.", answer: "tomodachi wa gakkou ni imasu." },
    { prompt: "neko wa ie de imasu.", answer: "neko wa ie ni imasu." },
    { prompt: "hon ga yomimasu.", answer: "hon wo yomimasu." },
    { prompt: "nihongo wo benkyou ni shimasu.", answer: "nihongo wo benkyou shimasu." },
    { prompt: "kyou ga ii desu.", answer: "kyou wa ii desu." },
    { prompt: "watashi wa koohii ni nomimasu.", answer: "watashi wa koohii wo nomimasu." },
  ],
};

const BANNED_LOANWORDS_RE = /\b(kuriimu|se-?rusu\s*mane-?ja|mane-?ja|insutorakuta|purogurama|toreenaa|depaato|kauntaa)\b/i;
const BANNED_SUBJECT_RE = /\b(ka|ki|ku|ke|sa|si|su|se)\b\s+wa\b/i;
const WORKBOOK_SAFE_SUBJECTS = "watashi, anata, kare, kanojo, tomodachi, sensei, neko, inu, haha, chichi, Tanaka-san, Suzuki-san";
const WORKBOOK_SAFE_VOCAB = `Safe vocabulary only: gohan, mizu, koohii, hon, gakkou, ie, kouen, eiga, terebi, kuruma, uchi, tabemono, densha, saifu.
Forbidden: kuriimu, se-rusu, mane-ja, insutorakuta, purogurama, toreenaa, depaato, or any advanced loanwords.`;

function sanitizeSection(qs: WorkbookQuestion[], sectionId: string): WorkbookQuestion[] {
  return qs.filter((q) => {
    if (sectionId === "reverse") {
      return /[א-ת]/.test(q.prompt);
    }
    if (BANNED_LOANWORDS_RE.test(q.prompt + " " + q.answer)) return false;
    if (BANNED_SUBJECT_RE.test(q.prompt)) return false;
    return true;
  });
}

// Extract romaji words from chunk texts (sequences of lowercase latin letters).
function extractRomajiVocab(texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    const matches = text.match(/\b[a-z]{2,}\b/g) ?? [];
    for (const word of matches) {
      if (word.length >= 2 && word.length <= 12) seen.add(word);
    }
  }
  // Keep only plausible romaji (no common English stopwords)
  const ENGLISH_STOPWORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all",
    "can", "her", "was", "one", "our", "out", "day", "get",
    "has", "him", "his", "how", "its", "may", "new", "now",
    "old", "see", "two", "way", "who", "did", "let", "put",
    "say", "she", "too", "use", "with", "from", "this", "that",
    "they", "will", "have", "been", "than", "then", "when",
  ]);
  return Array.from(seen).filter((w) => !ENGLISH_STOPWORDS.has(w));
}

// Strip model thinking blocks and internal log lines from any LLM output.
function stripModelArtifacts(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*(validat|generat|process|check|fixing|correcting|step \d|thinking)[^\n]*\n/gim, "")
    .trim();
}

// Remove lines in a Hebrew answer key that contain mixed Latin/Hebrew fragments.
// A line is considered corrupted if it has Latin letters mixed inside Hebrew text
// (e.g. "טנ aka", "סוזuki").
function cleanAnswerKey(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => {
    // If a numbered answer line contains both Hebrew characters AND isolated Latin word-fragments, flag it
    const hasHebrew = /[א-ת]/.test(line);
    const hasLatinFragment = /[א-ת][a-zA-Z]|[a-zA-Z][א-ת]/.test(line);
    if (hasHebrew && hasLatinFragment) {
      // Strip the Latin fragments, keep only Hebrew/spaces/punctuation/numbers
      return line.replace(/[a-zA-Z]+/g, "").replace(/\s{2,}/g, " ").trim();
    }
    return line;
  }).join("\n");
}

// Clean a numbered exercise list:
// - remove meta-questions and non-romaji lines
// - strip inline translations (anything after — or →)
function hebrewAnswerKeyPrompt(sentences: string, count: number, outputLanguage: string): string {
  const langNote = outputLanguage === "Hebrew"
    ? `Translate into natural, fluent Hebrew only. No Latin letters, no romaji, no English.

Use natural Hebrew phrasing:
  - "אני הולך לבית הספר" not "אני ילך לבית הספר"
  - "אני חוזר הביתה" not "אני חזר לבית"
  - "הוא שותה קפה" not "הוא שותה kaafi"

For proper names only, transliterate into Hebrew script:
  Tanaka → טנאקה, Suzuki → סוזוקי, Yamada → יאמאדה.

For common nouns, use Hebrew words — never leave loanwords untranslated:
  sensei → מורה, kaisha → חברה, gakkou → בית ספר,
  kouen → פארק, eiga → סרט, terebi → טלוויזיה,
  uchi/ie → בית, tomodachi → חבר/ה, neko → חתול, inu → כלב.

Write complete, natural Hebrew sentences. Never mix Latin characters inside a Hebrew word.`
    : `Translate into English only. No Japanese or romaji in the answers.`;

  return `You are a Japanese teacher. Translate each romaji sentence into ${outputLanguage}.

${langNote}

Rules:
- Output ONLY a numbered list (1–${count}). Nothing else — no headings, no comments, no explanations.
- Each answer must be a clean ${outputLanguage} translation on a single line.
- Do NOT include the original Japanese sentence in the answer.

Sentences:
${sentences.trim()}`;
}

// - strip trailing Hebrew/non-ASCII characters from exercise lines
function validateExerciseList(text: string, expected: number): string {
  const BAD_PATTERNS = [
    /what does/i,
    /what is/i,
    /how do you say/i,
    /translate the word/i,
    /which of the following/i,
  ];
  // Matches a numbered romaji-only sentence (latin letters, spaces, basic punctuation)
  const ROMAJI_LINE = /^\d+[.)]\s+[a-zA-Z\s,.'?!\-]+$/;

  const lines = text.split("\n");
  const valid: string[] = [];
  let num = 1;

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    if (BAD_PATTERNS.some((p) => p.test(trimmed))) continue;
    if (/^\d+[.)]/.test(trimmed)) {
      // Strip inline translation after — or →
      trimmed = trimmed.replace(/\s*[—→].*$/, "").trim();
      // Strip trailing non-ASCII (Hebrew, etc.) that leaked through
      trimmed = trimmed.replace(/[^\x00-\x7F]+.*$/, "").trim();
      if (!ROMAJI_LINE.test(trimmed)) continue;
      valid.push(trimmed.replace(/^\d+[.)]/, `${num}.`));
      num++;
      if (num > expected) break;
    }
  }

  return valid.join("\n");
}

async function embedText(text: string): Promise<number[]> {
  const res = await ollama.embed({ model: EMBED_MODEL, input: text });
  return res.embeddings[0]!;
}

// Stream a single chat call to stdout and the file stream simultaneously.
// Falls back to non-streaming if streaming fails.
async function streamChat(chatPrompt: string, fileStream: fs.WriteStream): Promise<void> {
  try {
    const stream = await ollama.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: chatPrompt }],
      stream: true,
    });
    for await (const part of stream) {
      const token = part.message.content;
      process.stdout.write(token);
      fileStream.write(token);
    }
  } catch {
    // Fallback: non-streaming
    const res = await ollama.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: chatPrompt }],
    });
    process.stdout.write(res.message.content);
    fileStream.write(res.message.content);
  }
}

async function generatePerLesson(
  chunks: EmbeddedChunk[],
  prompt: string,
  fileStream: fs.WriteStream
): Promise<void> {
  const includeExamples = wantsExamples(prompt);

  const byLesson = new Map<number, EmbeddedChunk[]>();
  for (const chunk of chunks) {
    if (chunk.sourceType === "lesson" && chunk.lessonNumber !== null) {
      const list = byLesson.get(chunk.lessonNumber) ?? [];
      list.push(chunk);
      byLesson.set(chunk.lessonNumber, list);
    }
  }

  const lessonNumbers = Array.from(byLesson.keys()).sort((a, b) => a - b);
  console.log(`Generating per-lesson output for ${lessonNumbers.length} lessons...\n`);

  const header = `# ${prompt}\n\n_Generated from lesson chunks only._\n\n`;
  process.stdout.write(header);
  fileStream.write(header);

  for (const lessonNum of lessonNumbers) {
    process.stdout.write(`\n---\n\n`);
    fileStream.write(`\n---\n\n`);

    const context = byLesson.get(lessonNum)!.map((c) => c.text).join("\n\n---\n\n");

    const examplesInstruction = includeExamples
      ? "Include 2 examples in format: Japanese (romaji) — translation"
      : "Do NOT include examples unless they appear verbatim in the context.";

    const sectionPrompt = `You are a Japanese language teacher. Based ONLY on the context below, write a brief lesson summary in Markdown.

## Lesson ${lessonNum}

Rules:
- Use max 4 bullet points total across all sections.
- Cover only: main topic, key grammar point(s), and core vocabulary.
- ${examplesInstruction}
- Do NOT add workbook or vocab sections.
- Do not invent vocabulary or grammar.
- Output only the ## Lesson ${lessonNum} section. Nothing else.

Context:
${context}`;

    await streamChat(sectionPrompt, fileStream);
  }
}

async function generateGeneral(
  chunks: EmbeddedChunk[],
  prompt: string,
  questionEmbedding: number[],
  fileStream: fs.WriteStream
): Promise<void> {
  const scored: ScoredChunk[] = chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(questionEmbedding, chunk.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);

  const context = scored.slice(0, 12).map(({ chunk }) =>
    `[${chunk.sourceType} / ${chunk.sourceFile}]\n${chunk.text}`
  ).join("\n\n---\n\n");

  const chatPrompt = `You are a Japanese language teacher. Generate a detailed study document in Markdown based on the request and context below.

Rules:
- Use ONLY vocabulary and structures from the provided context.
- Do not invent Japanese words. If unsure, omit.
- Format Japanese examples as: Japanese (romaji) — translation
- Output clean, well-structured Markdown with headings and sections.
- Be thorough — this is a study document, not a short answer.

Context:
${context}

Request: ${prompt}`;

  await streamChat(chatPrompt, fileStream);
}

async function validateGrammar(
  exercises: string,
  lessonContext: string,
  grammarContext: string
): Promise<string> {
  const validationPrompt = `You are a Japanese grammar validator. Fix any errors in the numbered romaji exercise list below.

Reference material (lesson context):
${lessonContext}

Grammar reference:
${grammarContext || "No grammar materials available. Use general N5-level rules."}

Fix these specific issues:
- Romaji must be ALL lowercase. Rewrite any uppercase romaji sentence.
- Replace English words with Japanese romaji: "home" → "ie", "school" → "gakkou", etc.
- Te-form: taberu→tabete, miru→mite, nomu→nonde, iku→itte, kuru→kite, suru→shite.
  Wrong: "miru te mo ii desu" → Correct: "mite mo ii desu"
- Particles:
  - location of action → de (e.g. "kouen de asobimasu")
  - direction or destination → ni (e.g. "gakkou ni ikimasu")
  - direct object → wo (e.g. "hon wo yomimasu")
  - topic → wa (e.g. "watashi wa gakusei desu")
  - subject / existence / preference → ga (e.g. "neko ga imasu")
- Reject unnatural sentences like:
  "dore wa watashi no saifu desu ka" → replace with "kore wa watashi no saifu desu ka"
  "watashi wa gakkou ni nihongo wo hanashimasu" → replace with "gakkou de nihongo wo hanashimasu"
- Do NOT make sentences more complex than the input.
- If a sentence is too broken to fix simply, replace it with a safe, simple N5 sentence.
- Do NOT add explanations, comments, or reasoning.
- Output ONLY the corrected numbered list. Preserve the exact count and order.
- Romaji only — no hiragana, katakana, or kanji.

Exercises to validate:
${exercises}`;

  const res = await ollama.chat({
    model: CHAT_MODEL,
    messages: [{ role: "user", content: validationPrompt }],
  });
  return res.message.content.trim();
}

async function generateShortWorksheet(
  chunks: EmbeddedChunk[],
  prompt: string,
  fileStream: fs.WriteStream
): Promise<void> {
  const count = extractCount(prompt, 5);
  const exerciseType = extractExerciseType(prompt);
  const outputLanguage = extractOutputLanguage(prompt);
  const includeAnswerKey = wantsAnswerKey(prompt);
  const difficulty = detectWorksheetDifficulty(prompt);

  const grammarContext = chunks
    .filter((c) => c.sourceType === "grammar")
    .slice(0, 10)
    .map((c) => c.text)
    .join("\n\n---\n\n");

  const lessonChunks = chunks.filter((c) => c.sourceType === "lesson");
  const context = lessonChunks.slice(0, 20).map((c) => c.text).join("\n\n---\n\n");
  const contextVocab = extractRomajiVocab(lessonChunks.slice(0, 20).map((c) => c.text));
  const preferredVocab = contextVocab.length > 0
    ? contextVocab.slice(0, 40).join(", ")
    : N5_FALLBACK_VOCAB.slice(0, 30).join(", ");

  const bank = loadExerciseBank();
  const usedQuestions = new Set(bank.map((e) => normalizeQuestion(e.question)));
  const reused = pickRelevantExercises(bank, difficulty, null, count, usedQuestions);
  const toGenerate = Math.max(0, count - reused.length);

  console.log(`  Total items      : ${count}`);
  console.log(`  Difficulty       : ${difficulty}`);
  console.log(`  Exercise type    : ${exerciseType}`);
  console.log(`  Output language  : ${outputLanguage}`);
  console.log(`  Answer key       : ${includeAnswerKey}`);
  console.log(`  Reusing from bank: ${reused.length}, generating new: ${toGenerate}\n`);

  const instructionLine = outputLanguage === "Hebrew" ? "תרגמו כל משפט לעברית." : "Translate each sentence into English.";
  const answerKeyLabel = outputLanguage === "Hebrew" ? "מפתח תשובות" : "Answer Key";
  const header = `# ${prompt}\n\n## ${outputLanguage === "Hebrew" ? "הוראות" : "Instructions"}\n${instructionLine}\n\n`;
  process.stdout.write(header);
  fileStream.write(header);

  let newQuestionsList: string[] = [];
  let newAnswersList: string[] = [];

  if (toGenerate > 0) {
    const avoidNote = reused.length > 0
      ? `\nDo NOT write any of these sentences (already used):\n${reused.map((e) => `- ${e.question}`).join("\n")}\n`
      : "";

    const questionsPrompt = `You are a Japanese teacher creating a romaji ${exerciseType} worksheet.

Write exactly ${toGenerate} Japanese sentences in romaji. Mix topics freely from the provided context.
${avoidNote}
${DIFFICULTY_PROMPTS[difficulty]}

Preferred vocabulary (use these first):
${preferredVocab}

If not enough vocabulary, use common N5-level words only. Avoid rare or invented words.

Rules:
- Output ONLY a numbered list (1–${toGenerate}). No headings, translations, or explanations.
- Every item must be a complete Japanese sentence in lowercase romaji only.
- No hiragana, katakana, kanji, or English words.
- Use Japanese romaji for all nouns: "ie" not "home", "gakkou" not "school".
- Do NOT repeat the same sentence structure more than twice.
- Do NOT write meta-questions like "What does X mean?".
- Te-form: taberu→tabete, miru→mite, nomu→nonde, iku→itte.
- Particles: de (location of action), ni (direction), wo (object), wa (topic), ga (subject).

Context:
${context}`;

    let rawQuestionsText = "";
    try {
      const stream = await ollama.chat({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: questionsPrompt }],
        stream: true,
      });
      for await (const part of stream) rawQuestionsText += part.message.content;
    } catch {
      const res = await ollama.chat({ model: CHAT_MODEL, messages: [{ role: "user", content: questionsPrompt }] });
      rawQuestionsText = res.message.content;
    }

    process.stderr.write("  Validating grammar...\n");
    const validated = await validateGrammar(stripModelArtifacts(rawQuestionsText), context, grammarContext);
    const cleanedNew = validateExerciseList(stripModelArtifacts(validated), toGenerate);
    newQuestionsList = parseNumberedList(cleanedNew);
  }

  const allQuestions = [...reused.map((e) => e.question), ...newQuestionsList];
  const questionsBlock = formatNumberedList(allQuestions);
  process.stdout.write(questionsBlock + "\n\n");
  fileStream.write(questionsBlock + "\n\n");

  if (includeAnswerKey) {
    if (toGenerate > 0 && newQuestionsList.length > 0) {
      const newQText = formatNumberedList(newQuestionsList);
      const answersPrompt = hebrewAnswerKeyPrompt(newQText, newQuestionsList.length, outputLanguage);
      const answersRes = await ollama.chat({ model: CHAT_MODEL, messages: [{ role: "user", content: answersPrompt }] });
      const rawAnswers = stripModelArtifacts(answersRes.message.content.trim());
      const cleanNew = outputLanguage === "Hebrew" ? cleanAnswerKey(rawAnswers) : rawAnswers;
      newAnswersList = parseNumberedList(cleanNew);
    }

    const allAnswers = [...reused.map((e) => e.answer), ...newAnswersList];
    const answersBlock = formatNumberedList(allAnswers);
    const fullAnswerSection = `\n---\n\n## ${answerKeyLabel}\n\n${answersBlock}\n`;
    process.stdout.write(fullAnswerSection);
    fileStream.write(fullAnswerSection);

    if (newQuestionsList.length > 0) {
      const entries = makeEntries(newQuestionsList, newAnswersList, exerciseType, difficulty, null);
      appendToExerciseBank(entries);
    }
  }
}

async function generatePracticeWorksheet(
  chunks: EmbeddedChunk[],
  prompt: string,
  fileStream: fs.WriteStream
): Promise<void> {
  const count = extractCount(prompt, 5);
  const exerciseType = extractExerciseType(prompt);
  const outputLanguage = extractOutputLanguage(prompt);
  const includeAnswerKey = wantsAnswerKey(prompt);
  const difficulty = detectWorksheetDifficulty(prompt);

  console.log(`  Items per lesson : ${count}`);
  console.log(`  Difficulty       : ${difficulty}`);
  console.log(`  Exercise type    : ${exerciseType}`);
  console.log(`  Output language  : ${outputLanguage}`);
  console.log(`  Answer key       : ${includeAnswerKey}\n`);

  const grammarContext = chunks
    .filter((c) => c.sourceType === "grammar")
    .slice(0, 10)
    .map((c) => c.text)
    .join("\n\n---\n\n");

  const byLesson = new Map<number, EmbeddedChunk[]>();
  for (const chunk of chunks) {
    if (chunk.sourceType === "lesson" && chunk.lessonNumber !== null) {
      const list = byLesson.get(chunk.lessonNumber) ?? [];
      list.push(chunk);
      byLesson.set(chunk.lessonNumber, list);
    }
  }

  const lessonNumbers = Array.from(byLesson.keys()).sort((a, b) => a - b);
  console.log(`Generating practice worksheet for ${lessonNumbers.length} lessons...\n`);

  const bank = loadExerciseBank();
  const usedQuestions = new Set(bank.map((e) => normalizeQuestion(e.question)));

  const instructionLine = exerciseType === "translation"
    ? (outputLanguage === "Hebrew" ? `תרגמו כל משפט לעברית.` : `Translate each sentence into English.`)
    : (outputLanguage === "Hebrew" ? `השלימו כל תרגיל. ענו בעברית.` : `Complete each exercise. Answer in English.`);
  const lessonLabel = outputLanguage === "Hebrew" ? "שיעור" : "Lesson";
  const answerKeyLabel = outputLanguage === "Hebrew" ? "מפתח תשובות" : "Answer Key";

  const header = `# ${prompt}\n\n## ${outputLanguage === "Hebrew" ? "הוראות" : "Instructions"}\n${instructionLine}\n\n`;
  process.stdout.write(header);
  fileStream.write(header);

  const answerSections: string[] = [];
  const allNewEntries: ExerciseEntry[] = [];

  for (const lessonNum of lessonNumbers) {
    const lessonChunkTexts = byLesson.get(lessonNum)!.map((c) => c.text);
    const context = lessonChunkTexts.join("\n\n---\n\n");
    const contextVocab = extractRomajiVocab(lessonChunkTexts);
    const preferredVocab = contextVocab.length > 0
      ? contextVocab.slice(0, 40).join(", ")
      : N5_FALLBACK_VOCAB.slice(0, 30).join(", ");

    const reused = pickRelevantExercises(bank, difficulty, lessonNum, count, usedQuestions);
    reused.forEach((e) => usedQuestions.add(normalizeQuestion(e.question)));
    const toGenerate = Math.max(0, count - reused.length);

    const lessonHeader = `## ${lessonLabel} ${lessonNum}\n\n`;
    process.stdout.write(lessonHeader);
    fileStream.write(lessonHeader);

    let newQuestionsList: string[] = [];
    let newAnswersList: string[] = [];

    if (toGenerate > 0) {
      const avoidNote = reused.length > 0
        ? `\nDo NOT write any of these sentences (already used):\n${reused.map((e) => `- ${e.question}`).join("\n")}\n`
        : "";

      const questionsPrompt = `You are a Japanese teacher creating a romaji ${exerciseType} worksheet.

Based ONLY on the context below, write exactly ${toGenerate} Japanese sentences in romaji for Lesson ${lessonNum}.
${avoidNote}
${DIFFICULTY_PROMPTS[difficulty]}

Preferred vocabulary (from the lesson material — use these first):
${preferredVocab}

If the context lacks enough vocabulary, you may use common N5-level words only. Avoid rare, complex, or invented words.

Rules:
- Output ONLY a numbered list (1–${toGenerate}). Nothing else — no headings, no translations, no explanations.
- Every item must be a complete Japanese sentence in lowercase romaji only. No hiragana, katakana, or kanji.
- Do NOT write questions like "What does X mean?" or "How do you say X?". Write sentences to translate, not meta-questions.
- Do NOT write in English. No English words — use Japanese romaji: "ie" not "home".
- Do NOT repeat the same sentence structure more than twice.
- Te-form: taberu→tabete, miru→mite, nomu→nonde, iku→itte.
- Particles: de (location of action), ni (direction), wo (object), wa (topic), ga (subject).

Context:
${context}`;

      let rawQuestionsText = "";
      try {
        const stream = await ollama.chat({
          model: CHAT_MODEL,
          messages: [{ role: "user", content: questionsPrompt }],
          stream: true,
        });
        for await (const part of stream) rawQuestionsText += part.message.content;
      } catch {
        const res = await ollama.chat({ model: CHAT_MODEL, messages: [{ role: "user", content: questionsPrompt }] });
        rawQuestionsText = res.message.content;
      }

      process.stderr.write(`  Validating grammar for lesson ${lessonNum}...\n`);
      const validated = await validateGrammar(rawQuestionsText, context, grammarContext);
      const cleanedNew = validateExerciseList(validated, toGenerate);
      newQuestionsList = parseNumberedList(cleanedNew);
      newQuestionsList.forEach((q) => usedQuestions.add(normalizeQuestion(q)));
    }

    const allQuestions = [...reused.map((e) => e.question), ...newQuestionsList];
    const questionsBlock = formatNumberedList(allQuestions);
    process.stdout.write(questionsBlock + "\n\n");
    fileStream.write(questionsBlock + "\n\n");

    if (includeAnswerKey) {
      if (toGenerate > 0 && newQuestionsList.length > 0) {
        const newQText = formatNumberedList(newQuestionsList);
        const answersPrompt = hebrewAnswerKeyPrompt(newQText, newQuestionsList.length, outputLanguage);
        const answersRes = await ollama.chat({ model: CHAT_MODEL, messages: [{ role: "user", content: answersPrompt }] });
        const rawAnswers = stripModelArtifacts(answersRes.message.content.trim());
        const cleanNew = outputLanguage === "Hebrew" ? cleanAnswerKey(rawAnswers) : rawAnswers;
        newAnswersList = parseNumberedList(cleanNew);
      }

      const allAnswers = [...reused.map((e) => e.answer), ...newAnswersList];
      const answersBlock = formatNumberedList(allAnswers);
      answerSections.push(`### ${lessonLabel} ${lessonNum}\n${answersBlock}`);

      if (newQuestionsList.length > 0) {
        const entries = makeEntries(newQuestionsList, newAnswersList, exerciseType, difficulty, lessonNum);
        allNewEntries.push(...entries);
      }
    }
  }

  if (includeAnswerKey && answerSections.length > 0) {
    const answerHeader = `\n---\n\n## ${answerKeyLabel}\n\n`;
    process.stdout.write(answerHeader);
    fileStream.write(answerHeader);
    for (const section of answerSections) {
      process.stdout.write(section + "\n\n");
      fileStream.write(section + "\n\n");
    }
  }

  if (allNewEntries.length > 0) appendToExerciseBank(allNewEntries);
}

async function generateFullWorkbook(
  chunks: EmbeddedChunk[],
  prompt: string,
  fileStream: fs.WriteStream
): Promise<void> {
  const difficulty = detectWorksheetDifficulty(prompt);
  const outputLanguage = extractOutputLanguage(prompt);
  const n = 10;
  const diffLabel = difficulty === "default" ? "Mixed" : difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
  const diffHint = difficulty === "hard"
    ? "Use longer N5 sentences (6–10 words). Include te-form, negatives, and questions."
    : difficulty === "easy"
    ? "Short N5 sentences (2–5 words). Basic patterns only."
    : "Mix short and medium N5 sentences (3–8 words). Include at least 1 question, 1 negative, 1 verb.";

  const lessonChunks = chunks.filter((c) => c.sourceType === "lesson");
  const context = lessonChunks.slice(0, 20).map((c) => c.text).join("\n\n---\n\n");
  const grammarContext = chunks
    .filter((c) => c.sourceType === "grammar")
    .slice(0, 10)
    .map((c) => c.text)
    .join("\n\n---\n\n");
  const contextVocab = extractRomajiVocab(lessonChunks.slice(0, 20).map((c) => c.text));
  const preferredVocab = contextVocab.length > 0
    ? contextVocab.slice(0, 40).join(", ")
    : N5_FALLBACK_VOCAB.slice(0, 30).join(", ");

  const bank = loadExerciseBank();
  const usedQuestions = new Set(bank.map((e) => normalizeQuestion(e.question)));
  const allNewEntries: ExerciseEntry[] = [];

  async function llmCall(userPrompt: string): Promise<string> {
    const res = await ollama.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: userPrompt }],
    });
    return stripModelArtifacts(res.message.content.trim());
  }

  // --- Section spec definitions ---
  interface SectionSpec {
    id: string;
    title: string;
    instructions: string;
    generate: () => Promise<WorkbookQuestion[]>;
    fallback: () => WorkbookQuestion[];
  }

  const specs: SectionSpec[] = [
    {
      id: "translation",
      title: `Part 1: Translation (Japanese → ${outputLanguage})`,
      instructions: outputLanguage === "Hebrew" ? "תרגמו כל משפט לעברית." : "Translate each sentence into English.",
      fallback: () => FALLBACK_WQ.translation!.slice(0, n),
      generate: async () => {
        const reused = pickRelevantExercises(bank, difficulty, null, n, usedQuestions);
        reused.forEach((e) => usedQuestions.add(normalizeQuestion(e.question)));
        const toGen = Math.max(0, n - reused.length);
        let newQs: string[] = [];
        let newAs: string[] = [];
        if (toGen > 0) {
          const avoidNote = reused.length > 0
            ? `\nDo NOT use: ${reused.map((e) => `"${e.question}"`).join(", ")}\n` : "";
          const raw = await llmCall(`You are a Japanese teacher. Write exactly ${toGen} romaji sentences for a translation exercise.
${avoidNote}
${DIFFICULTY_PROMPTS[difficulty]}
${BEGINNER_SAFE_RULES}

Subjects to use: ${WORKBOOK_SAFE_SUBJECTS}.
${WORKBOOK_SAFE_VOCAB}

Good examples:
- watashi wa gakkou ni ikimasu.
- tomodachi wa kouen de asobimasu.
- neko wa ie ni imasu.
- watashi wa hon wo yomimasu ka.
- kare wa koohii wo nomimasen.

Rules:
- Output ONLY a numbered list (1–${toGen}). Lowercase romaji only.
- No hiragana, kanji, English words, or explanations.
- Vary: avoid >2 "X wa Y desu". Include 1 verb sentence, 1 question, 1 negative.

Context:
${context}`);
          process.stderr.write("  Validating part 1 grammar...\n");
          const validated = await validateGrammar(raw, context, grammarContext);
          newQs = parseNumberedList(validateExerciseList(stripModelArtifacts(validated), toGen));
          newQs.forEach((q) => usedQuestions.add(normalizeQuestion(q)));
          if (newQs.length > 0) {
            const aRaw = await llmCall(hebrewAnswerKeyPrompt(formatNumberedList(newQs), newQs.length, outputLanguage));
            newAs = parseNumberedList(outputLanguage === "Hebrew" ? cleanAnswerKey(aRaw) : aRaw);
          }
        }
        const allQs = [...reused.map((e) => e.question), ...newQs];
        const allAs = [...reused.map((e) => e.answer), ...newAs];
        if (newQs.length > 0) allNewEntries.push(...makeEntries(newQs, newAs, "translation", difficulty, null));
        return allQs.map((q, i) => ({ prompt: q, answer: allAs[i] ?? "" })).filter((q) => q.prompt && q.answer);
      },
    },
    {
      id: "reverse",
      title: `Part 2: Reverse Translation (${outputLanguage} → Japanese)`,
      instructions: outputLanguage === "Hebrew" ? "כתבו כל משפט ביפנית (romaji)." : "Write each sentence in Japanese (romaji).",
      fallback: () => FALLBACK_WQ.reverse!.slice(0, n),
      generate: async () => {
        const qRaw = await llmCall(`You are a Japanese teacher. Write exactly ${n} Hebrew sentences (עברית) for students to translate INTO Japanese romaji.

⚠️ CRITICAL: Every sentence MUST be written in Hebrew script (א-ת). Do NOT write romaji, English, or Japanese.

CORRECT examples:
1. אני הולך לבית הספר.
2. הוא אוכל אורז בבית.
3. האם את שותה קפה?
4. החתול יושב בבית.
5. אנחנו לומדים יפנית.

WRONG — do NOT do this:
✗ Watashi wa gakkou ni ikimasu.
✗ Ka wa tabemasu.
✗ Any romaji or English text.

${diffHint}

Rules:
- Output ONLY a numbered list (1–${n}).
- Every item: a complete Hebrew sentence in Hebrew characters only.
- Cover: daily activities, locations, food, family, school.
- Vary: declarative, question, negative.
- Use natural, beginner-level Hebrew that maps to N5 Japanese.`);
        const qList = parseNumberedList(qRaw);
        if (qList.length === 0) return [];
        const aRaw = await llmCall(`You are a Japanese teacher. Translate each ${outputLanguage} sentence into Japanese romaji.

${BEGINNER_SAFE_RULES}

Preferred vocabulary from lessons: ${preferredVocab}

Rules:
- Output ONLY a numbered list (1–${qList.length}).
- Each answer: correct romaji sentence, lowercase only.

Sentences:
${formatNumberedList(qList)}`);
        process.stderr.write("  Validating part 2 answers...\n");
        const validated = await validateGrammar(aRaw, context, grammarContext);
        const aList = parseNumberedList(validateExerciseList(stripModelArtifacts(validated), qList.length));
        return qList.slice(0, aList.length).map((q, i) => ({ prompt: q, answer: aList[i] ?? "" }));
      },
    },
    {
      id: "fillblank",
      title: "Part 3: Fill in the Blank",
      instructions: outputLanguage === "Hebrew" ? "מלאו כל משפט במילה הנכונה ביפנית (romaji)." : "Fill in each blank with the correct Japanese word (romaji).",
      fallback: () => FALLBACK_WQ.fillblank!.slice(0, n),
      generate: async () => {
        const qRaw = await llmCall(`You are a Japanese teacher. Write exactly ${n} fill-in-the-blank exercises in romaji.

Each sentence has EXACTLY ONE blank: ___. Vary blank types: noun, verb, particle.

${diffHint}
${BEGINNER_SAFE_RULES}

Subjects to use: ${WORKBOOK_SAFE_SUBJECTS}.
${WORKBOOK_SAFE_VOCAB}

Rules:
- Output ONLY a numbered list (1–${n}).
- Each item: sentence with exactly one ___. Lowercase romaji only.
- Examples: "watashi wa ___ wo tabemasu." / "kare wa gakkou ___ ikimasu." / "hon wo ___."

Context:
${context}`);
        const qList = parseNumberedList(qRaw).filter((q) => q.includes("___"));
        if (qList.length === 0) return [];
        const aRaw = await llmCall(`You are a Japanese teacher. Provide the single missing word for each fill-in-the-blank exercise.

Rules:
- Output ONLY a numbered list (1–${qList.length}).
- Each answer: exactly one romaji word. No full sentences.

Exercises:
${formatNumberedList(qList)}`);
        const aList = parseNumberedList(aRaw);
        return qList.slice(0, aList.length).map((q, i) => ({ prompt: q, answer: aList[i] ?? "" }));
      },
    },
    {
      id: "multiplechoice",
      title: "Part 4: Multiple Choice",
      instructions: outputLanguage === "Hebrew" ? "הקיפו את התשובה הנכונה." : "Circle the correct answer.",
      fallback: () => FALLBACK_WQ.multiplechoice!.slice(0, n),
      generate: async () => {
        const qRaw = await llmCall(`You are a Japanese teacher. Write exactly ${n} multiple choice exercises.

Each exercise: a romaji sentence with ONE blank (___) and exactly 3 options (A, B, C).

${diffHint}
${BEGINNER_SAFE_RULES}

Subjects to use: ${WORKBOOK_SAFE_SUBJECTS}.
${WORKBOOK_SAFE_VOCAB}

Output format — STRICTLY two lines per question:
1. [romaji sentence with ___]
   A) [option1]  B) [option2]  C) [option3]

Rules:
- Output ONLY the numbered questions with option lines. No answers, no explanations.
- Test: particles (wa, wo, ni, de, ga), verb forms, common vocabulary.
- All options lowercase romaji. One clearly correct answer. Distractors must be plausible.

Context:
${context}`);
        const mcItems = parseMultipleChoiceBlock(qRaw, n);
        if (mcItems.length === 0) return [];
        const questionsText = mcItems
          .map((item, i) => `${i + 1}. ${item.q}${item.opts ? `\n   ${item.opts}` : ""}`)
          .join("\n\n");
        const aRaw = await llmCall(`You are a Japanese teacher. For each multiple choice question, provide the correct answer.

Format: "N. [letter]) [correct option text]" — example: "1. B) ni"

Rules:
- Output ONLY a numbered list (1–${mcItems.length}).
- Each answer: letter and correct option. No explanations.

Questions:
${questionsText}`);
        const aList = parseNumberedList(aRaw);
        return mcItems.slice(0, aList.length).map((item, i) => ({
          prompt: item.opts ? `${item.q}\n${item.opts}` : item.q,
          answer: aList[i] ?? "",
        }));
      },
    },
    {
      id: "sentencebuilding",
      title: "Part 5: Sentence Building",
      instructions: outputLanguage === "Hebrew" ? "סדרו את המילים למשפט נכון." : "Arrange the words into a correct sentence.",
      fallback: () => FALLBACK_WQ.sentencebuilding!.slice(0, n),
      generate: async () => {
        const qRaw = await llmCall(`You are a Japanese teacher. Write exactly ${n} sentence-building exercises.

Each exercise: slash-separated romaji words in scrambled order that students arrange into a sentence.

${diffHint}
${BEGINNER_SAFE_RULES}

Subjects to use: ${WORKBOOK_SAFE_SUBJECTS}.
${WORKBOOK_SAFE_VOCAB}

Rules:
- Output ONLY a numbered list (1–${n}).
- Each item: 3–6 words in random order, separated by " / ". Include particles.
- Every item must produce a UNIQUE sentence when correctly arranged. No duplicates.
- Lowercase romaji only. Do NOT include the correct sentence.

Context:
${context}`);
        const qList = parseNumberedList(qRaw).filter((q) => q.includes("/"));
        if (qList.length === 0) return [];
        const aRaw = await llmCall(`You are a Japanese teacher. Arrange each scrambled word set into the correct Japanese sentence (romaji).

${BEGINNER_SAFE_RULES}

Rules:
- Output ONLY a numbered list (1–${qList.length}).
- Each answer: correctly ordered romaji sentence ending with a period.

Word sets:
${formatNumberedList(qList)}`);
        process.stderr.write("  Validating part 5 answers...\n");
        const validated = await validateGrammar(aRaw, context, grammarContext);
        const aList = parseNumberedList(stripModelArtifacts(validated));
        const raw = qList.slice(0, aList.length).map((q, i) => ({ prompt: q, answer: aList[i] ?? "" }));
        // Deduplicate by answer to prevent repeated correct sentences
        const seenAnswers = new Set<string>();
        return raw.filter((q) => {
          const norm = normalizeQuestion(q.answer);
          if (seenAnswers.has(norm)) return false;
          seenAnswers.add(norm);
          return true;
        });
      },
    },
    {
      id: "errorcorrection",
      title: "Part 6: Error Correction",
      instructions: outputLanguage === "Hebrew" ? "בכל משפט יש שגיאה אחת. כתבו את המשפט הנכון." : "Each sentence has ONE error. Write the corrected sentence.",
      fallback: () => FALLBACK_WQ.errorcorrection!.slice(0, n),
      generate: async () => {
        const qRaw = await llmCall(`You are a Japanese teacher. Write exactly ${n} romaji sentences, each with EXACTLY ONE intentional grammar error.

Error types to vary (use each type at least once):
- Wrong particle: "gakkou ni tabemasu" (should be de) / "hon ni yomimasu" (should be wo)
- Wrong verb form: "watashi wa taberu" (should be tabemasu)
- Wrong te-form: "miru te mo ii desu" (should be mite mo ii desu)
- Wrong negative: "tabemasen desu" (should be tabemasen)
- Particle swap: "inu wo imasu" (should be ga)

${diffHint}
${BEGINNER_SAFE_RULES}

Subjects to use: ${WORKBOOK_SAFE_SUBJECTS}.
${WORKBOOK_SAFE_VOCAB}

Rules:
- Output ONLY a numbered list (1–${n}).
- Each item: one sentence with exactly one error. Lowercase romaji only.
- No hints, no correct versions. Each sentence must be unique and plausible.

Context:
${context}`);
        const qList = parseNumberedList(qRaw);
        if (qList.length === 0) return [];
        const aRaw = await llmCall(`You are a Japanese teacher. Fix the ONE grammar error in each sentence below.

${BEGINNER_SAFE_RULES}

Rules:
- Output ONLY a numbered list (1–${qList.length}).
- Each answer: the fully corrected romaji sentence, lowercase. No explanations.

Sentences:
${formatNumberedList(qList)}`);
        process.stderr.write("  Validating part 6 corrections...\n");
        const validated = await validateGrammar(aRaw, context, grammarContext);
        const aList = parseNumberedList(stripModelArtifacts(validated));
        return qList.slice(0, aList.length).map((q, i) => ({ prompt: q, answer: aList[i] ?? "" }));
      },
    },
  ];

  // --- Generate all sections with validation, retry, and fallback ---
  const sections: WorkbookSection[] = [];
  for (const spec of specs) {
    process.stderr.write(`  Generating ${spec.title}...\n`);
    let qs = sanitizeSection(await spec.generate(), spec.id);
    const err = validateSectionQuestions(qs, n);
    if (err) {
      process.stderr.write(`  Retrying ${spec.title} (${err})...\n`);
      qs = sanitizeSection(await spec.generate(), spec.id);
      const err2 = validateSectionQuestions(qs, n);
      if (err2) {
        process.stderr.write(`  Using fallback for ${spec.title} (${err2})\n`);
        qs = spec.fallback();
      }
    }
    sections.push({ id: spec.id, title: spec.title, instructions: spec.instructions, questions: qs.slice(0, n) });
  }

  // --- Format final Markdown only after all sections validated ---
  function write(text: string): void {
    process.stdout.write(text);
    fileStream.write(text);
  }

  write(`# ${prompt}\n\n_Difficulty: ${diffLabel} | ${n} questions per section_\n\n`);

  for (const section of sections) {
    write(`## ${section.title}\n\n_${section.instructions}_\n\n`);
    for (let i = 0; i < section.questions.length; i++) {
      const q = section.questions[i]!;
      if (q.prompt.includes("\n")) {
        const lines = q.prompt.split("\n");
        write(`${i + 1}. ${lines[0]!.trim()}\n`);
        for (const ln of lines.slice(1)) {
          if (ln.trim()) write(`   ${ln.trim()}\n`);
        }
        write("\n");
      } else {
        write(`${i + 1}. ${q.prompt}\n`);
      }
    }
    write("\n");
  }

  write(`\n---\n\n## Answer Key\n\n`);
  for (const section of sections) {
    write(`### ${section.title}\n\n`);
    write(formatNumberedList(section.questions.map((q) => q.answer)) + "\n\n");
  }

  if (allNewEntries.length > 0) appendToExerciseBank(allNewEntries);
}

async function main() {
  const { prompt, outName } = parseArgs();
  if (!prompt) {
    console.error("Usage: ts-node src/create-file.ts <prompt> [--out filename]");
    process.exit(1);
  }

  if (!fs.existsSync(EMBEDDINGS_PATH)) {
    console.error("Embeddings not found:", EMBEDDINGS_PATH);
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const filename = (outName ?? slugify(prompt)) + ".md";
  const outPath = path.join(OUTPUT_DIR, filename);
  const fileStream = fs.createWriteStream(outPath, { encoding: "utf-8" });

  const chunks: EmbeddedChunk[] = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, "utf-8"));
  console.log(`Loaded ${chunks.length} embeddings.`);
  console.log(`Prompt: ${prompt}\n`);

  if (isFullWorkbookRequest(prompt)) {
    console.log("Mode: full workbook\n");
    await generateFullWorkbook(chunks, prompt, fileStream);
  } else if (isPerLessonPractice(prompt)) {
    console.log("Mode: practice worksheet (per lesson)\n");
    await generatePracticeWorksheet(chunks, prompt, fileStream);
  } else if (isPracticeFileRequest(prompt)) {
    console.log("Mode: practice worksheet (short)\n");
    await generateShortWorksheet(chunks, prompt, fileStream);
  } else if (isPerLessonRequest(prompt)) {
    console.log("Mode: per-lesson structured output\n");
    await generatePerLesson(chunks, prompt, fileStream);
  } else {
    console.log("Mode: general document\n");
    console.log("Creating prompt embedding...");
    const qEmbed = await embedText(prompt);
    await generateGeneral(chunks, prompt, qEmbed, fileStream);
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  console.log(`\n\nSaved to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
