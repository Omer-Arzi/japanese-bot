import * as fs from "fs";
import * as path from "path";
import { llm } from "./llm/LlmService";

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
  practice:    { summary: 5, lesson: 1, vocab: 1, workbook: 1, genki: 0, unknown: 0 },
  explanation: { summary: 6, lesson: 1, vocab: 1, workbook: 0, genki: 0, unknown: 0 },
  planning:    { summary: 5, lesson: 1, vocab: 1, workbook: 1, genki: 0, unknown: 0 },
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

// Empty parentheses artifacts from PDF extraction: (), ( ), (  )
const EMPTY_PARENS_RE = /\(\s*\)/g;

// Lines that are only a bare number (PDF page artifacts like "08", "-08")
function isPageArtifact(line: string): boolean {
  return /^-?\s*\d{1,3}\s*$/.test(line.trim());
}

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
  const seen = new Set<string>();

  return text
    .replace(EMPTY_PARENS_RE, "")
    .split("\n")
    .filter((line) => !COMMAND_LINE_RE.test(line))
    .filter((line) => !isPageArtifact(line))
    .map((line) => line.replace(ARABIC_RE, "").replace(CYRILLIC_RE, "").replace(KOREAN_RE, ""))
    .map(stripStrayLatin)
    .filter((line) => line.trim().length > 0)
    // Remove exact duplicate lines (repeated explanations)
    .filter((line) => {
      const key = line.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n")
    .replace(QUOTED_COMMAND_RE, "")
    .replace(DUPLICATE_PARENS_RE, "$1")
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
- を marks the DIRECT OBJECT — the whole object, even when it is a list.
- と connects nouns into a list meaning "and". It does NOT mark any object by itself.
  When と is used to list nouns before を, を marks the ENTIRE list as the direct object.
  CORRECT: "ラーメンとぎょうざを食べます (ra-men to gyouza wo tabemasu) — I eat ramen and gyoza"
  NEVER say: "を marks the first object" or "を marks only the noun before it"
  ALWAYS say: "を marks the whole list as the direct object"
- に marks direction, destination, time, or indirect object.
- で marks location of action or means.
- て-form is a VERB FORM, not a particle.
- Never claim が marks the object. Never claim を marks the subject.
- Do not mix Arabic script or unrelated writing systems into explanations.
- For Japanese examples, use: Japanese (romaji) — translation

Example quality rules — always apply:
- Before writing any example, ask: does this make sense in real life?
- Verb+noun pairing must be semantically natural:
  taberu (eat) → food only. nomimasu (drink) → liquids only. yomimasu (read) → text/books.
- Adjective+noun pairing must be semantically natural:
  BAD: "kono hon wa oishii desu" — books are not delicious.
  GOOD: "kono ramen wa oishii desu" — food is delicious.
  oishii → food. omoshiroi → books, movies, people. kirei → places, people, flowers. tanoshii → activities.
- Use beginner vocabulary only: watashi, anata, tomodachi, sensei, neko, inu, hon, mizu, gohan, koohii, gakkou, ie, kouen.
- One example per grammar point is enough. Do not pad with similar examples.

Romaji accuracy — exact romanization lookup for 書く (kaku, "to write"):
  書く        = kaku
  書きます    = kakimasu       ← NOT kimasu (kimasu = "come")
  書いて      = kaite          ← NOT kite   (kite   = "come, te-form")
  書いています = kaite imasu   ← NOT kite imasu
  書いた      = kaita
  書きません  = kakimasen
Never confuse the く→き→か stem of 書く with き (the stem of くる, "to come").
When you write a romaji reading next to any form of 書, check: does it start with "ka"?

Known exceptions — never overgeneralize from these:
- いく (iku) → いって (itte) in te-form. This is an IRREGULAR EXCEPTION.
  DO NOT say "all く verbs become ～って". Most く verbs follow the regular pattern:
  かく → かいて, きく → きいて, あるく → あるいて.
  Always label iku→itte as "an important exception to the regular rule".
- きれい (kirei, beautiful/clean) is a NA-ADJECTIVE, not an i-adjective.
  It ends in い but does NOT conjugate like an i-adjective.
  WRONG: きれいくない. CORRECT: きれいじゃない / きれいではない.
  Same applies to きらい (kirai, dislike) — also na-adjective despite ending in い.
  When explaining adjectives, explicitly note: "Words ending in い are usually i-adjectives,
  but きれい and きらい are important exceptions — they are na-adjectives."
`;


const HEBREW_BASE_RULES = `
כללי שפה עברית — חובה לפעול לפיהם:
- כתוב עברית תקנית, שוטפת וטבעית. אל תתרגם מילולית מאנגלית.
- ההסבר חייב להיות עברית בלבד. מותר רק: אותיות עבריות, יפנית/רומאג'י בדוגמאות, ספרות.
  אסור לחלוטין: ערבית, קירילית, קוריאנית, אנגלית בתוך משפטים עבריים.
  הכלל: אם אתה כותב משפט עברי — כל המילים הן עברית. יפנית מופיעה רק כדוגמה מובחנת.
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
- אל תכתוב סוגריים ריקים: () או ( ).
- אל תכתוב מספרים בודדים שאינם חלק ממשפט (כמו "08" או "-08").
- אל תחזור על אותה נקודה פעמיים בתשובה — כל רעיון מופיע פעם אחת בלבד.
- אם החומר שסופק מכיל טקסט רועש או ארטיפקטים של PDF — אל תעתיק אותם. נסח מחדש בצורה נקייה וטבעית.

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
- を = מושא ישיר — מסמן את כל המושא, גם כשהוא רשימה.
  כשמשתמשים ב-と לחיבור שמות עצם ואז ב-を, החלקיק を מסמן את כל הרשימה יחד כמושא.
  נכון: ラーメンとぎょうざを食べます (ra-men to gyouza wo tabemasu) — "אני אוכל ראמן וגיוזה"
  אסור לומר: "を מסמן את המושא הראשון" — כי שניהם המושא.
  יש לומר: "を מסמן את כל הרשימה כמושא ישיר"
- と = מחבר שמות עצם לרשימה עם משמעות "ו-". אינו מסמן מושא בעצמו.
- に = יעד, זמן, מיקום סטטי (איפה משהו נמצא), מושא עקיף.
- で = המקום שבו מתבצעת פעולה, או האמצעי שבו משתמשים.
  הבחנה חשובה — תמיד הסבר עם זוג דוגמאות מנוגדות:
    東京にいます (toukyou ni imasu) — "אני נמצא בטוקיו" [מיקום סטטי — に]
    東京で働きます (toukyou de hatarakimasu) — "אני עובד בטוקיו" [מקום ביצוע פעולה — で]
- צורת て היא צורת פועל — לא חלקיק.
- אל תטען ש-が מסמן מושא. אל תטען ש-を מסמן נושא.

איכות דוגמאות — חובה לפעול לפי כללים אלה:
- לפני כתיבת דוגמה — בדוק: האם זה הגיוני במציאות?
- צירוף פועל+מושא חייב להיות טבעי סמנטית:
  taberu (לאכול) → אוכל בלבד. nomimasu (לשתות) → נוזלים בלבד. yomimasu (לקרוא) → טקסט/ספרים.
- צירוף שם תואר+שם עצם חייב להיות טבעי סמנטית:
  שגוי: "kono hon wa oishii desu" — ספרים אינם טעימים.
  נכון: "kono ramen wa oishii desu" — אוכל הוא טעים.
  oishii → אוכל בלבד. omoshiroi → ספרים, סרטים, אנשים. kirei → מקומות, אנשים, פרחים.
- אוצר מילים למתחילים בלבד: watashi, tomodachi, sensei, neko, inu, hon, mizu, gohan, koohii, gakkou, ie, kouen.
- דוגמה אחת לכל נקודה דקדוקית מספיקה. אל תרבה בדוגמאות דומות.

חריגים ידועים — אסור להכליל מהם:
- いく (iku) → いって (itte) בצורת て — זהו חריג לא-סדיר.
  אסור לומר "כל פעלי く הופכים ל-～って". רוב פעלי く פועלים לפי הכלל הרגיל:
  かく → かいて, きく → きいて, あるく → あるいて.
  תמיד ציין: "iku→itte הוא חריג חשוב לכלל הרגיל".
- きれい (kirei, יפה/נקי) — שם תואר מסוג な (na-adjective), לא i-adjective.
  הוא מסתיים ב-い אבל אינו מוטה כמו i-adjective.
  שגוי: きれいくない. נכון: きれいじゃない / きれいではない.
  כך גם きらい (kirai, לא אוהב) — na-adjective למרות שמסתיים ב-い.
  כשמסבירים שמות תואר, ציין במפורש: "מילים המסתיימות ב-い הן בדרך כלל i-adjective,
  אך きれい ו-きらい הן חריגים חשובים — הן na-adjective".

נכונות פעלים — דוגמאות נכונות:
  hatarakimasu (לעבוד) — לא "atsukite"
  kakimasu (לכתוב) — לא "kaku masu"
  tabemasu (לאכול) — לא "tabe masu"
  ikimasu (ללכת) — לא "iku masu"
`;

const TEACHING_STYLE = `
Teaching style — always follow:
- Prioritize clarity over linguistic precision. Keep explanations beginner-friendly unless advanced detail is explicitly requested.
- Distinguish between beginner intuition and strict linguistics when both are relevant. Lead with the intuition.
- Prioritize natural Japanese usage and communication intent over literal word-by-word translation.
- When relevant, briefly mention nuance, politeness level, or cultural context.
- Do not overload explanations with edge cases. Mention one or two if critical; skip the rest.
- If a grammar rule has exceptions, say so explicitly. Never treat an exception as the general rule.
  Example: いく → いって is an important exception. Most く verbs become ～いて instead.
- Do not derive broad grammar rules from a single example.
- Do not classify words by surface appearance alone. Check the actual word type.
  Example: きれい ends in い but is a na-adjective, not an i-adjective. Always verify, never assume.
- Avoid overconfident language for nuanced or advanced topics. Say "in most cases" or "generally" when appropriate.
- Avoid repetitive phrasing, padding, and AI-sounding filler. Every sentence should add something.
`;

const TEACHING_STYLE_HE = `
סגנון הוראה — חובה לפעול לפיו:
- העדף בהירות על פני דיוק בלשני. שמור על גישה מתאימה למתחילים אלא אם נדרש הסבר מתקדם במפורש.
- הבחן בין אינטואיציה של מתחיל לבין דקדוק מדויק כשהשניים רלוונטיים. התחל עם האינטואיציה.
- העדף שימוש טבעי ביפנית על פני תרגום מילולי. ההסבר צריך לשקף איך יפנים מדברים בפועל.
- כשרלוונטי, הסבר בקצרה ניואנס, רמת נימוס, או הקשר תרבותי.
- אל תעמיס הסבר באי-יוצאים מן הכלל. ציין אחד או שניים אם חיוניים; השמט את השאר.
- אם לכלל דקדוקי יש חריגים — אמור זאת במפורש. אל תציג חריג ככלל כללי.
  דוגמה: いく → いって הוא חריג חשוב. רוב פעלי く הופכים ל-～いて.
- אל תסיק כללי דקדוק רחבים ממשל אחד.
- אל תסווג מילים לפי מראה חיצוני בלבד. בדוק את סוג המילה בפועל.
  דוגמה: きれい מסתיים ב-い אבל הוא na-adjective, לא i-adjective. תמיד ודא, אל תניח.
- הימנע מביטחון יתר בנושאים עדינים או מתקדמים. השתמש ב"בדרך כלל" כשמתאים.
- אל תחזור על ניסוחים, אל תמלא במילים ריקות, ואל תישמע כמו AI. כל משפט צריך להוסיף משהו.
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

  const base       = `${OUTPUT_RULES}${GRAMMAR_ACCURACY_RULES}${TEACHING_STYLE}`;
  const hebrewBase = `${OUTPUT_RULES}${HEBREW_BASE_RULES}${TEACHING_STYLE_HE}`;

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
- אל תחזור על אותו רעיון פעמיים. כל נקודה מופיעה פעם אחת בלבד.
- אל תכתוב סוגריים ריקים, מספרים בודדים, או ארטיפקטים של PDF.

נושאים שמותר תמיד להסביר (גם ללא הקשר):
  חלקיקים: は, が, を, に, で, へ, も, と, の
  צורות פועל: ます, て, עבר, שלילי
  מבנה משפט בסיסי, ברכות, מספרים

ציין את סוג הנושא: חלקיק / צורת פועל / תבנית משפט / אחר.

מבנה התשובה:
  1. הסבר פשוט וברור
  2. 2–3 דוגמאות בפורמט: יפנית (romaji) — תרגום
     (השתמש בצירופים טבעיים בלבד: gohan+tabemasu, mizu+nomimasu, hon+yomimasu, gakkou+ikimasu)
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

Example quality:
- Use only natural verb+noun pairings: eat+food, drink+water, read+book, go+school.
- Never invent odd combos just to fill space (e.g. "eat the desk", "drink the book").
- Beginner vocabulary only: watashi, tomodachi, neko, gohan, mizu, hon, gakkou, ie.

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
  const questionEmbedding = await llm.embed(question);

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
  const answer = await llm.chat([{ role: "user", content: prompt }]);

  console.log("Answer:\n");
  console.log(cleanOutput(answer));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
