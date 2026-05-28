import * as fs from "fs";
import * as path from "path";
import { llm } from "./llm/LlmService";

// ─── Types ────────────────────────────────────────────────────────────────────

type QuestionMode = "practice" | "explanation" | "planning" | "lookup";
type GrammarIntent = "explanation" | "analysis" | "correction" | "general";
type Difficulty = "easy" | "medium" | "hard";

// ─── Detection keywords ───────────────────────────────────────────────────────

const MODE_KEYWORDS: Record<QuestionMode, string[]> = {
  practice:    ["practice", "drill", "exercise", "quiz", "write", "fill", "repeat", "תרגיל", "תרגול"],
  planning:    ["plan", "schedule", "syllabus"],
  explanation: ["explain", "what is", "how does", "meaning"],
  // lookup detection is handled by detectLookupIntent() — keywords unused
  lookup:      [],
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
  // lookup bypasses MIX entirely — uses top-N across all source types
  lookup:      { summary: 0, lesson: 0, vocab: 0, workbook: 0, genki: 0, unknown: 0 },
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

// ─── Lookup intent detection ──────────────────────────────────────────────────

// Patterns that indicate the user wants to find where a topic appears in the
// indexed course materials, rather than asking for a grammar explanation.
//
// Rules for adding patterns:
//   - Strong unambiguous signals only (past tense "learned/studied", explicit "lesson number", etc.)
//   - Each pattern must match at least one real query that should be routed as lookup
//   - Test every addition with the smoke-test at the bottom of this section
const LOOKUP_PATTERNS: RegExp[] = [
  // "lesson number" as a noun phrase — unambiguous signal
  /\blesson\s+number\b/i,

  // "which/what lesson" immediately adjacent — "which lesson covers X", "what lesson is this?"
  /\b(which|what)\s+(lesson|class|unit|chapter)\b/i,

  // "what ... lesson ..." with words in between — "what is the lesson for X"
  /\bwhat\b.{0,30}\blesson\b/i,

  // "where in the course/materials/lessons"
  /\bwhere\s+(in\s+(the\s+)?(course|materials?|lessons?|class))\b/i,

  // "where is this explained/covered/found"
  /\bwhere\s+(is|was)\s+(this|it|that)\s+(explained|covered|taught|found)\b/i,

  // "where did we learn/study"
  /\bwhere\s+did\s+we\s+(learn|study|cover)\b/i,

  // "did we (already) learn/study/cover"
  /\bdid\s+we\s+(already\s+)?(learn|study|cover|see|do)\b/i,

  // "have we learned/studied/covered"
  /\bhave\s+we\s+(learned|studied|covered|seen)\b/i,

  // "we learned/studied about" — past tense is a strong lookup signal
  /\bwe\s+(learned|studied|covered)\s+about\b/i,

  // "we learned X" without "about" — e.g. "the lesson number we learned X"
  /\bwe\s+(learned|studied)\b/i,

  // "from lesson N" — "from lesson 1-12", "from lesson 3"
  /\bfrom\s+lesson\s+\d/i,

  // lesson range — "lesson 1-12", "lessons 1–6"
  /\blesson[s]?\s+\d+\s*[-–]\s*\d+\b/i,

  // "is/was this covered/taught/explained"
  /\b(was|is)\s+(this|it)\s+covered\b/i,

  // "covered/taught/explained in lesson/class/the course"
  /\b(covered|taught|explained)\s+in\s+(lesson|class|the\s+course)\b/i,

  // "when did we learn/study"
  /\bwhen\s+did\s+we\s+(learn|study|cover|do)\b/i,

  // "is this in lesson / the course / my materials"
  /\bis\s+this\s+in\s+(lesson|the\s+course|my\s+materials?)\b/i,

  // "do we have / is there a lesson on"
  /\b(do\s+we\s+have|is\s+there)\s+a\s+(lesson|class|unit)\s+on\b/i,

  // "in my (course) materials"
  /\bin\s+my\s+(course\s+)?materials?\b/i,

  // "in the course/class materials"
  /\bin\s+the\s+(course|class)\s+materials?\b/i,

  // "lesson N covers/teaches/explains/includes something"
  /\blesson\s+\d+.*?(cover|teach|explain|include)\b/i,

  // Hebrew
  /באיזה\s+שיעור/,
  /באיזו\s+יחידה/,
  /האם\s+למדנו/,
  /כבר\s+למדנו/,
  /מספר\s+שיעור/,
  /איפה\s+ב(חומר|שיעורים?|קורס)/,
  /מתי\s+למדנו/,
  /האם\s+זה\s+מופיע\s+ב/,
  /למדנו\s+(על|את)\b/,
];

function detectLookupIntent(question: string): boolean {
  return LOOKUP_PATTERNS.some((re) => re.test(question));
}

// Lookup sub-type:
//   "teaching"   — user wants the lesson where X was formally introduced
//   "appearance" — user wants to know where X appears at all (incl. workbook)
type LookupType = "teaching" | "appearance";

const APPEARANCE_PATTERNS: RegExp[] = [
  /\bwhere\s+does\s+.{0,40}\bappear\b/i,
  /\bwhere\s+(is|are)\s+.{0,40}\b(mentioned|used|found|referenced)\b/i,
  /\bin\s+(the\s+)?workbook\b/i,
  /\bin\s+(the\s+)?exercises?\b/i,
  /\bwhich\s+exercises?\b/i,
  /\bappears?\s+in\b/i,
  // Hebrew
  /איפה\s+מופיע/,
  /בתרגילים/,
];

function detectLookupType(question: string): LookupType {
  return APPEARANCE_PATTERNS.some((re) => re.test(question)) ? "appearance" : "teaching";
}

// ─── Detection functions ──────────────────────────────────────────────────────

function detectIntent(question: string): GrammarIntent {
  const q = question.toLowerCase();
  for (const intent of ["correction", "analysis", "explanation"] as GrammarIntent[]) {
    if (INTENT_KEYWORDS[intent].some((kw) => q.includes(kw))) return intent;
  }
  return "general";
}

function detectMode(question: string): QuestionMode {
  // Lookup takes precedence — check before any other mode
  if (detectLookupIntent(question)) return "lookup";
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
  boostedScore?: number;
}

// ─── Topic index types ────────────────────────────────────────────────────────

type TopicMatchConfidence = "explicit-teaching" | "grammar-reference" | "incidental-mention";

interface TopicIndexMatch {
  chunkId: string;
  sourceType: string;
  sourceFile: string;
  lessonNumber: number | null;
  confidence: TopicMatchConfidence;
  excerpt: string;
  matchedAliases: string[];
}

interface TopicIndexEntry {
  key: string;
  aliases: string[];
  matches: TopicIndexMatch[];
  summary: {
    totalMatches: number;
    hasLessonEvidence: boolean;
    hasGrammarReference: boolean;
    hasIncidental: boolean;
    lessonNumbers: number[];
  };
}

type TopicIndex = Record<string, TopicIndexEntry>;

// ─── Chunk evidence classification ───────────────────────────────────────────

type ChunkEvidence = "teaching" | "incidental";

interface ClassifiedChunk {
  scored: ScoredChunk;
  evidence: ChunkEvidence;
  reason: string;
}

// Source types that carry explicitly taught material
const TEACHING_SOURCE_TYPES = new Set(["lesson", "summary", "syllabus", "grammar"]);
// Source types that only show examples or practice
const INCIDENTAL_SOURCE_TYPES = new Set(["workbook", "exercise", "vocab"]);

// Content-level signals that a chunk is a teaching section, not just an example
const TEACHING_CONTENT_SIGNALS: RegExp[] = [
  /grammar\s+point/i,
  /this\s+lesson\s+(covers?|introduces?|teaches?|explains?)/i,
  /we\s+(learn|study)\s+(about\s+)?the/i,
  /introduction\s+to\b/i,
  /^#{1,3}\s+/m,          // markdown heading — teaching section
  /lesson\s+\d+\s*[:\-]/i, // "Lesson 3:" / "Lesson 3 -" heading style
  /今日の文法|文法ポイント/,   // Japanese "today's grammar" / "grammar point"
];

function classifyChunk(chunk: EmbeddedChunk): { evidence: ChunkEvidence; reason: string } {
  if (TEACHING_SOURCE_TYPES.has(chunk.sourceType)) {
    return { evidence: "teaching", reason: `sourceType=${chunk.sourceType}` };
  }
  if (INCIDENTAL_SOURCE_TYPES.has(chunk.sourceType)) {
    return { evidence: "incidental", reason: `sourceType=${chunk.sourceType}` };
  }
  // Unknown source type — fall back to content signals
  const hasTeachingContent = TEACHING_CONTENT_SIGNALS.some((re) => re.test(chunk.text));
  return hasTeachingContent
    ? { evidence: "teaching", reason: "unknown sourceType but teaching signals found in content" }
    : { evidence: "incidental", reason: "unknown sourceType, no teaching signals" };
}

// ─── Topic index helpers ──────────────────────────────────────────────────────

function loadTopicIndex(): TopicIndex | null {
  const indexPath = path.join(process.cwd(), "data", "topic-index.json");
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf-8")) as TopicIndex;
  } catch {
    return null;
  }
}

// Maps question patterns to topic keys in topic-index.json
const TOPIC_KEY_PATTERNS: { pattern: RegExp; key: string }[] = [
  { pattern: /\bte[-\s]?form\b|\bて[-\s]?form\b|て形/i,                           key: "te-form" },
  { pattern: /\bは\s*(?:vs?|and|versus)\s*が\b|\bwa\s*(?:vs?|and|versus)\s*ga\b/i, key: "particles-wa-ga" },
  { pattern: /\bparticle\s+は\b|\bは\s+particle\b|\btopic\s+(?:marker|particle)\b/i, key: "particle-wa" },
  { pattern: /\bparticle\s+が\b|\bが\s+particle\b|\bsubject\s+(?:marker|particle)\b/i, key: "particle-ga" },
  { pattern: /\bparticle\s+を\b|\bを\s+particle\b|\b(?:wo|direct\s+object\s+marker)\b/i, key: "particle-wo" },
  { pattern: /\bに\s*(?:vs?|and|versus)\s*で\b|\bni\s*(?:vs?|and|versus)\s*de\b/i, key: "particles-ni-de" },
  { pattern: /\bparticle\s+に\b|\bに\s+particle\b|\bni\s+(?:particle|direction|destination)\b/i, key: "particle-ni" },
  { pattern: /\bparticle\s+で\b|\bで\s+particle\b|\bde\s+(?:particle|location|action)\b/i, key: "particle-de" },
  { pattern: /\bparticle\s+と\b|\bと\s+particle\b/i,                              key: "particle-to" },
  { pattern: /\bparticle\s+の\b|\bの\s+particle\b|\bpossession\s+の\b/i,           key: "particle-no" },
  { pattern: /\bparticle\s+も\b|\bも\s+particle\b/i,                              key: "particle-mo" },
  { pattern: /\bna[-\s]?adjective[s]?\b|\bな[-\s]?形容詞\b/i,                     key: "na-adjectives" },
  { pattern: /\bi[-\s]?adjective[s]?\b|\bい[-\s]?形容詞\b/i,                      key: "i-adjectives" },
  { pattern: /\bます\s*(?:form)?\b|\bpolite\s+form\b|\bmasu\s+form\b/i,           key: "masu-form" },
  { pattern: /\bnegative\s+(?:form|verb)\b|\bません\b|\bnai\s+form\b|\bmasen\b/i, key: "negative-form" },
  { pattern: /\bpast\s+tense\b|\bました\b|\bmashita\b|\bta[-\s]form\b/i,           key: "past-tense" },
  { pattern: /\bpast\s+negative\b|\bませんでした\b/i,                              key: "past-negative" },
  { pattern: /\bimasu\b|\barimasu\b|\bいます\b|\bあります\b|\bexistence\s+verb\b/i, key: "existence-verbs" },
  { pattern: /\bdemonstrative[s]?\b|\bkore\b|\bsore\b|\bこれ\b|\bそれ\b/i,        key: "demonstratives" },
  { pattern: /\bhiragana\b|\bひらがな\b/i,                                          key: "hiragana" },
  { pattern: /\bkatakana\b|\bカタカナ\b/i,                                          key: "katakana" },
  { pattern: /\bcounting\b|\bcounter[s]?\b|\bnumber[s]?\s+(?:in\s+japanese|system)\b/i, key: "numbers-counting" },
  { pattern: /\btime\s+expression[s]?\b|\bwhat\s+time\b|\b何時\b/i,               key: "time-expressions" },
  { pattern: /\bgreeting[s]?\b|\bこんにちは\b|\bおはよう\b/i,                       key: "greetings" },
  { pattern: /\bself.?introduction\b|\b自己紹介\b/i,                               key: "self-introduction" },
  { pattern: /\binvitation[s]?\b|\bませんか\b|\bましょう\b/i,                       key: "invitations-requests" },
  { pattern: /\bfrequency\s+adverb[s]?\b|\bいつも\b|\bよく\b|\bときどき\b/i,        key: "frequency-adverbs" },
  { pattern: /\blocation\s+word[s]?\b|\bここ\b|\bそこ\b|\bあそこ\b/i,              key: "location-place" },
  { pattern: /\bsentence\s+structure\b|\bword\s+order\b|\bSOV\b/i,                key: "sentence-structure" },
];

function detectTopicKey(question: string): string | null {
  for (const { pattern, key } of TOPIC_KEY_PATTERNS) {
    if (pattern.test(question)) return key;
  }
  return null;
}

function buildTopicIndexContext(entry: TopicIndexEntry, lookupType: LookupType): string {
  const { matches, summary } = entry;

  // For "teaching" lookups, prefer explicit-teaching then grammar-reference.
  // For "appearance" lookups, include all matches.
  const lessonMatches   = matches.filter((m) => m.confidence === "explicit-teaching");
  const grammarMatches  = matches.filter((m) => m.confidence === "grammar-reference");
  const incidentalMatches = matches.filter((m) => m.confidence === "incidental-mention");

  // Deduplicate lesson-evidence by lessonNumber, keeping one excerpt per lesson
  const seenLessons = new Set<number>();
  const dedupedLesson = lessonMatches.filter((m) => {
    if (m.lessonNumber === null) return true;
    if (seenLessons.has(m.lessonNumber)) return false;
    seenLessons.add(m.lessonNumber);
    return true;
  });

  // Deduplicate grammar-reference by sourceFile
  const seenFiles = new Set<string>();
  const dedupedGrammar = grammarMatches.filter((m) => {
    if (seenFiles.has(m.sourceFile)) return false;
    seenFiles.add(m.sourceFile);
    return true;
  });

  const fmtMatch = (m: TopicIndexMatch): string => {
    const tag = m.lessonNumber !== null ? `Lesson ${m.lessonNumber}` : "No lesson number";
    return `[${tag} / ${m.sourceType} / ${m.sourceFile}]\n${m.excerpt}`;
  };

  const lessonSection = dedupedLesson.length > 0
    ? "=== LESSON EVIDENCE (topic formally introduced in a numbered lesson) ===\n\n" +
      dedupedLesson.map(fmtMatch).join("\n\n---\n\n")
    : "=== LESSON EVIDENCE ===\n\n(none found)";

  const grammarSection = dedupedGrammar.length > 0
    ? "=== GRAMMAR REFERENCE (grammar/summary materials — topic explained but no lesson number assigned) ===\n\n" +
      dedupedGrammar.map(fmtMatch).join("\n\n---\n\n")
    : "=== GRAMMAR REFERENCE ===\n\n(none found)";

  const incidentalSection = lookupType === "appearance" && incidentalMatches.length > 0
    ? "=== INCIDENTAL APPEARANCES (workbook/exercise — examples only, not formal instruction) ===\n\n" +
      incidentalMatches.slice(0, 10).map(fmtMatch).join("\n\n---\n\n")
    : lookupType === "appearance"
      ? "=== INCIDENTAL APPEARANCES ===\n\n(none found)"
      : "";

  const sections = [lessonSection, grammarSection];
  if (incidentalSection) sections.push(incidentalSection);

  const lessonNumberList = summary.lessonNumbers.length > 0
    ? `\n[Topic index summary: found in lessons ${summary.lessonNumbers.join(", ")}; total matches: ${summary.totalMatches}]`
    : `\n[Topic index summary: no numbered lessons found; total matches: ${summary.totalMatches}]`;

  return sections.join("\n\n") + lessonNumberList;
}

// ─── Query expansion for lookup retrieval ────────────────────────────────────

// Each entry: if the question matches `pattern`, add `terms` to the embedding query.
const GRAMMAR_EXPANSIONS: { pattern: RegExp; terms: string[] }[] = [
  {
    pattern: /\bte[-\s]?form\b|\bて[-\s]?form\b|て形/i,
    terms: ["te-form", "て-form", "て形", "te form", "verb te-form conjugation", "connecting form", "verb ending て"],
  },
  {
    pattern: /\bは\s*(?:vs?|and|versus)\s*が\b|\bwa\s*(?:vs?|and|versus)\s*ga\b|\b(?:は|wa)\s+(?:が|ga)\s+(?:particle|difference)\b/i,
    terms: ["は が particle comparison", "topic marker subject marker", "wa ga difference"],
  },
  {
    pattern: /\bnegative\s+(?:form|verb)\b|\bません\b|\bない\s+form\b|\bnai\s+form\b|\bmasen\b/i,
    terms: ["negative form", "ません masen", "ない nai", "verb negation", "negative conjugation"],
  },
  {
    pattern: /\bpast\s+tense\b|\bました\b|\bmashita\b|\bta[-\s]form\b/i,
    terms: ["past tense", "ました mashita", "た-form ta-form", "verb past conjugation"],
  },
  {
    pattern: /\bna[-\s]?adjective[s]?\b|\bな[-\s]?adjective[s]?\b|\bな形容詞\b/i,
    terms: ["na-adjective", "な形容詞 na adjective", "adjective な conjugation"],
  },
  {
    pattern: /\bi[-\s]?adjective[s]?\b|\bい[-\s]?adjective[s]?\b|\bい形容詞\b/i,
    terms: ["i-adjective", "い形容詞 i adjective", "adjective い negative"],
  },
  {
    pattern: /\bparticle[s]?\s+を\b|\bを\s+particle\b|\b(?:wo|wo\s+particle)\b/i,
    terms: ["particle を wo", "direct object marker", "object particle"],
  },
  {
    pattern: /\bに\s*(?:vs?|and|versus)\s*で\b|\bde\s*(?:vs?|and|versus)\s*ni\b/i,
    terms: ["に vs で particle", "location action vs direction", "ni de comparison"],
  },
  {
    pattern: /\bparticle[s]?\s+に\b|\bに\s+particle\b|\bni\s+(?:particle|direction|destination)\b/i,
    terms: ["particle に ni", "direction destination time indirect object"],
  },
  {
    pattern: /\bparticle[s]?\s+で\b|\bで\s+particle\b|\bde\s+(?:particle|location|action)\b/i,
    terms: ["particle で de", "location of action means"],
  },
  {
    pattern: /\bます\s*(?:form)?\b|\bpolite\s+form\b|\bmasu\s+form\b/i,
    terms: ["ます form masu", "polite verb form", "verb conjugation ます"],
  },
  {
    pattern: /\bparticle[s]?\s+と\b|\bと\s+particle\b|\band\s+particle\b/i,
    terms: ["particle と to", "noun list and", "connecting nouns"],
  },
];

function extractTopicVariants(question: string): string[] {
  const found: string[] = [];
  for (const { pattern, terms } of GRAMMAR_EXPANSIONS) {
    if (pattern.test(question)) {
      found.push(...terms);
    }
  }
  return [...new Set(found)];
}

function buildExpandedQuery(question: string, variants: string[]): string {
  if (variants.length === 0) return question;
  return `${question}\n\nRelated terms: ${variants.join(", ")}`;
}

// ─── Per-chunk lexical boost for lookup retrieval ─────────────────────────────

function computeLexicalBoost(chunk: EmbeddedChunk, variants: string[]): number {
  let boost = 0;
  const text = chunk.text;
  const textLower = text.toLowerCase();

  // Teaching source type
  if (TEACHING_SOURCE_TYPES.has(chunk.sourceType)) boost += 0.08;

  // Markdown heading or "Lesson N:" heading pattern — section title
  if (/^#{1,3}\s+/m.test(text) || /lesson\s+\d+\s*[:\-]/i.test(text)) boost += 0.06;

  // Explicit grammar teaching language
  if (/grammar\s+point/i.test(text) || /今日の文法|文法ポイント/.test(text)) boost += 0.08;
  if (/this\s+lesson\s+(covers?|introduces?|teaches?|explains?)/i.test(text))  boost += 0.06;
  if (/introduction\s+to\b/i.test(text))                                        boost += 0.04;

  // Conjugation / form explanation language
  if (/\b(conjugat|inflect|verb\s+form|verb\s+ending|grammar\s+pattern)\b/i.test(text)) boost += 0.04;

  // Variant term matches — each match adds a small boost, capped
  let matches = 0;
  for (const v of variants) {
    if (v.length >= 3 && textLower.includes(v.toLowerCase())) matches++;
  }
  boost += Math.min(matches * 0.03, 0.09);

  return boost;
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

// ─── BM25-lite keyword scoring (debug only) ───────────────────────────────────

interface KeywordResult {
  chunk: EmbeddedChunk;
  score: number;
  matchedTerms: string[];
}

function computeKeywordScores(chunks: EmbeddedChunk[], terms: string[]): KeywordResult[] {
  const results: KeywordResult[] = [];
  for (const chunk of chunks) {
    const textLower = chunk.text.toLowerCase();
    const matched: string[] = [];
    for (const term of terms) {
      if (term.length >= 3 && textLower.includes(term.toLowerCase())) {
        matched.push(term);
      }
    }
    if (matched.length > 0) {
      results.push({ chunk, score: matched.length, matchedTerms: [...new Set(matched)] });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

// ─── System prompts ───────────────────────────────────────────────────────────

// Format retrieved chunks for lookup mode.
//
// Three-section context passed to the LLM:
//   1. LESSON EVIDENCE     — teaching chunks with a known lessonNumber
//   2. GRAMMAR REFERENCE   — teaching chunks without a lessonNumber (e.g. fundamentals.pdf)
//   3. INCIDENTAL APPEARANCES — workbook/exercise chunks
//
// Future extension points (not yet implemented):
//   - syllabus metadata file (maps topic → lesson range)
//   - lesson-topic mapping JSON (lesson N teaches: [te-form, particles, ...])
//   - topic index file generated at embed time
// When those exist, LESSON EVIDENCE can be enriched with confirmed lesson numbers
// even for chunks sourced from undated grammar PDFs.
function buildLookupContext(classified: ClassifiedChunk[]): string {
  // Split teaching into lesson-mapped vs grammar-reference (no lesson number)
  const lessonEvidence  = classified.filter((c) => c.evidence === "teaching" && c.scored.chunk.lessonNumber !== null);
  const grammarRef      = classified.filter((c) => c.evidence === "teaching" && c.scored.chunk.lessonNumber === null);
  const incidental      = classified.filter((c) => c.evidence === "incidental");

  const fmt = ({ scored: { chunk } }: ClassifiedChunk): string => {
    const lessonTag = chunk.lessonNumber !== null ? `Lesson ${chunk.lessonNumber}` : "No lesson number";
    return `[${lessonTag} / ${chunk.sourceType} / ${chunk.sourceFile}]\n${chunk.text}`;
  };

  const lessonSection = lessonEvidence.length > 0
    ? "=== LESSON EVIDENCE (topic formally introduced in a numbered lesson) ===\n\n" +
      lessonEvidence.map(fmt).join("\n\n---\n\n")
    : "=== LESSON EVIDENCE ===\n\n(none found)";

  const grammarSection = grammarRef.length > 0
    ? "=== GRAMMAR REFERENCE (grammar/summary materials — topic explained but no lesson number assigned) ===\n\n" +
      grammarRef.map(fmt).join("\n\n---\n\n")
    : "=== GRAMMAR REFERENCE ===\n\n(none found)";

  const incidentalSection = incidental.length > 0
    ? "=== INCIDENTAL APPEARANCES (workbook/exercise — examples only, not formal instruction) ===\n\n" +
      incidental.map(fmt).join("\n\n---\n\n")
    : "=== INCIDENTAL APPEARANCES ===\n\n(none found)";

  return `${lessonSection}\n\n\n${grammarSection}\n\n\n${incidentalSection}`;
}

function buildSystemPrompt(
  intent: GrammarIntent,
  mode: QuestionMode,
  difficulty: Difficulty,
  language: "hebrew" | "english",
  lookupType?: LookupType,
): string {
  const lang = language === "hebrew"
    ? "You are a Japanese teacher. Answer in Hebrew."
    : "You are a Japanese teacher. Answer in English.";

  // ── Lookup mode: only answer from retrieved context ────────────────────────
  if (mode === "lookup") {
    const isTeachingQuery = (lookupType ?? "teaching") === "teaching";

    if (language === "hebrew") {
      const teachingRule = isTeachingQuery
        ? `כללי תשובה לשאלת חיפוש-הוראה (לפי סדר עדיפות):
1. אם "ראיות שיעור" מכילות מספר שיעור — ענה: "שיעור X — [ציטוט קצר]"
2. אם רק "חומר עזר דקדוקי" מכיל את הנושא (ללא מספר שיעור) — ענה:
   "מצאתי את הנושא בחומרי הדקדוק, אבל לא הצלחתי למפות אותו לשיעור ממוספר."
3. אם רק "ראיות אינצידנטליות" מכילות את הנושא — ענה:
   "מצאתי דוגמאות לכך בחומרים, אבל לא מצאתי את השיעור שבו זה נלמד רשמית."
4. אם אין ראיות כלל — ענה: "לא מצאתי את זה בחומרי הקורס המאונדקסים."

אסור להמציא מספרי שיעור. אסור להסיק מספר שיעור מהקשר אינצידנטלי בלבד.`
        : `- ציין את כל המקומות שבהם הנושא מופיע — בשיעורים, בחומר עזר, ובתרגילים.
- ציין את sourceType עבור כל ציון.
- אם אין ראיות כלל — אמור: "לא מצאתי את זה בחומרי הקורס המאונדקסים."`;

      return `${lang}
אתה עוזר חיפוש בחומרי הקורס. ענה רק מהקטעים שסופקו — אסור להשתמש בידע יפנית כללי.

ההקשר מחולק לשלושה חלקים:
  ראיות שיעור      — שיעורים עם מספר שיעור ידוע (הרמה הגבוהה ביותר).
  חומר עזר דקדוקי — דקדוק/סיכום ללא מספר שיעור (הנושא מוסבר אך לא שויך לשיעור).
  ראיות אינצידנטליות — חוברת עבודה/תרגילים (הנושא מופיע כדוגמה בלבד).

${teachingRule}

פורמט תשובה:
  כשיש מספר שיעור:
    שיעור X — {העתק ביטוי קצר ישירות מהטקסט שנשלף, או השמט אם אין ציטוט מתאים}
  כשאין מספר שיעור:
    {sourceType}: {העתק ביטוי קצר ישירות מהטקסט שנשלף, או השמט אם אין ציטוט מתאים}

חשוב: אסור לכתוב טקסט-מציין-מיקום כמו [ציטוט קצר], [excerpt], [quote here], או כל טקסט בסוגריים מרובעים במקום תוכן אמיתי. צטט את הטקסט האמיתי שנשלף, או השמט לחלוטין.`;
    }

    const teachingRule = isTeachingQuery
      ? `Answer rules for a teaching-lookup query (apply in priority order):
1. If LESSON EVIDENCE contains the topic with a lesson number → report: "Lesson X — [short quote]"
2. If only GRAMMAR REFERENCE contains the topic (no lesson number) → respond with:
   "I found this topic in the grammar materials, but I couldn't map it to a numbered lesson."
3. If only INCIDENTAL APPEARANCES contain the topic → respond with:
   "I found examples of this in the materials, but I couldn't find the lesson where it is explicitly taught."
4. If none of the sections mention the topic → respond with:
   "I couldn't find this in the indexed course materials."

Do NOT invent lesson numbers. Do NOT infer a lesson number from incidental or grammar-reference evidence.`
      : `- Report all locations where the topic appears — lesson, grammar reference, and incidental.
- Include the sourceType for each location.
- If none of the sections mention the topic, respond with:
  "I couldn't find this in the indexed course materials."`;

    return `You are a course material search assistant.
Answer ONLY from the retrieved excerpts. Do NOT use your general Japanese knowledge.

The context is split into three sections:
  LESSON EVIDENCE       — chunks from numbered lessons (highest confidence for lesson mapping).
  GRAMMAR REFERENCE     — grammar/summary chunks without a lesson number (topic is explained but not lesson-tagged).
  INCIDENTAL APPEARANCES — workbook/exercise chunks (topic appears as example only).

${teachingRule}

Answer format:
  When a lesson number is known:
    Lesson X — {copy a short phrase directly from the retrieved text, or omit if nothing fits}
  When no lesson number is available:
    {sourceType}: {copy a short phrase directly from the retrieved text, or omit if nothing fits}

IMPORTANT: Never output placeholder text such as [short quote], [excerpt], [quote here], or any text in square brackets as a substitution for real content. Either quote the real retrieved text or omit the quote entirely.`;
  }

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

  // Detect mode first so lookup can expand the query before embedding
  const intent       = detectIntent(question);
  const mode         = detectMode(question);
  const difficulty   = detectDifficulty(question);
  const lessonNumber = detectLessonNumber(question);
  const language     = detectLanguage(question);
  const lookupType   = mode === "lookup" ? detectLookupType(question) : undefined;

  // ── Topic index early-return (lookup mode only) ──────────────────────────
  // Query the pre-built topic index before touching embeddings. If the question
  // maps to a known grammar topic, we can answer directly from exact-match data.
  const debugLookupEarly = mode === "lookup" && process.env.COURSE_LOOKUP_DEBUG === "true";

  if (mode === "lookup") {
    const topicIndex = loadTopicIndex();
    const topicKey   = topicIndex ? detectTopicKey(question) : null;
    const topicEntry = topicKey && topicIndex ? topicIndex[topicKey] : undefined;

    if (debugLookupEarly) {
      console.log("\n╔══════════════════════════════════════════════╗");
      console.log("║  COURSE_LOOKUP DEBUG MODE                    ║");
      console.log("╚══════════════════════════════════════════════╝");
      console.log(`\n  Original question : "${question}"`);
      console.log(`  Lookup type       : ${lookupType}`);
      console.log(`  Topic index loaded: ${topicIndex ? "yes" : "no (file missing)"}`);
      console.log(`  Detected topic key: ${topicKey ?? "(none)"}`);
      if (topicEntry) {
        console.log(`  Topic index matches: ${topicEntry.summary.totalMatches}`);
        console.log(`    lesson evidence   : ${topicEntry.summary.hasLessonEvidence} — lessons [${topicEntry.summary.lessonNumbers.join(", ")}]`);
        console.log(`    grammar reference : ${topicEntry.summary.hasGrammarReference}`);
        console.log(`    incidental        : ${topicEntry.summary.hasIncidental}`);
        const aliases = topicEntry.matches.flatMap((m) => m.matchedAliases);
        const topAliases = [...new Set(aliases)].slice(0, 10);
        console.log(`    matched aliases   : ${topAliases.join(", ")}`);
      }
    }

    if (topicEntry) {
      const context      = buildTopicIndexContext(topicEntry, lookupType ?? "teaching");
      const systemPrompt = buildSystemPrompt(intent, mode, difficulty, language, lookupType);
      const prompt       = `${systemPrompt}\n\nContext:\n${context}\n\nQuestion: ${question}`;

      console.log(`\nTopic index hit: "${topicKey}" (${topicEntry.summary.totalMatches} matches, lessons [${topicEntry.summary.lessonNumbers.join(", ")}])`);
      if (debugLookupEarly) console.log(`\n${"═".repeat(60)}\n`);

      console.log("\nAsking model...\n");
      const answer = await llm.chat([{ role: "user", content: prompt }]);
      console.log("Answer:\n");
      console.log(cleanOutput(answer));
      return;
    }

    if (debugLookupEarly) {
      console.log(`  → No topic index hit; falling through to semantic retrieval`);
      console.log(`\n${"═".repeat(60)}\n`);
    }
  }

  // For lookup: expand the query with grammar synonyms for better retrieval
  const topicVariants   = mode === "lookup" ? extractTopicVariants(question) : [];
  const embeddingQuery  = buildExpandedQuery(question, topicVariants);

  if (topicVariants.length > 0) {
    console.log(`Query expansion: ${topicVariants.join(" | ")}`);
  }

  console.log("Creating question embedding...");
  const questionEmbedding = await llm.embed(embeddingQuery);

  // Score all chunks with cosine similarity against the (possibly expanded) query
  const allScored: ScoredChunk[] = chunks.map((chunk) => ({
    chunk,
    rawScore: cosineSimilarity(questionEmbedding, chunk.embedding),
  }));
  allScored.sort((a, b) => b.rawScore - a.rawScore);

  let selected: ScoredChunk[];
  let classifiedChunks: ClassifiedChunk[] | undefined;

  const debugLookup = mode === "lookup" && process.env.COURSE_LOOKUP_DEBUG === "true";

  if (mode === "lookup") {
    if (debugLookup) {
      console.log("\n╔══════════════════════════════════════════════╗");
      console.log("║  COURSE_LOOKUP DEBUG — SEMANTIC FALLBACK     ║");
      console.log("╚══════════════════════════════════════════════╝");
      console.log(`  (topic index had no hit for this question)`);
      console.log(`  Topic variants    : ${topicVariants.length > 0 ? topicVariants.join(", ") : "(none)"}`);
      console.log(`\n  Embedding query sent to model:\n  ┌─────────────────────────────────────────────\n  │ ${embeddingQuery.replace(/\n/g, "\n  │ ")}\n  └─────────────────────────────────────────────`);

      // ── Stage 1: raw semantic scores ────────────────────────────────────────
      console.log(`\n── Stage 1: Top 15 raw semantic scores (BEFORE boost) ──`);
      const maxRaw = allScored[0]?.rawScore ?? 0;
      console.log(`  Max score in corpus: ${maxRaw.toFixed(4)}${maxRaw < 0.30 ? "  ⚠ WARNING: all scores low — possible embedding mismatch" : ""}`);
      for (const { chunk, rawScore } of allScored.slice(0, 15)) {
        const lesson  = chunk.lessonNumber !== null ? `lesson=${chunk.lessonNumber}` : "lesson=?";
        const preview = chunk.text.slice(0, 100).replace(/\n/g, " ");
        console.log(`  ${rawScore.toFixed(4)}  src=${chunk.sourceType.padEnd(10)}  ${lesson.padEnd(10)}  ${chunk.id}`);
        console.log(`         "${preview}"`);
      }

      // ── Stage 2: BM25-lite keyword results ──────────────────────────────────
      const keywordTerms = [...new Set([...topicVariants, ...question.split(/\s+/).filter((t) => t.length >= 4)])];
      const kwResults    = computeKeywordScores(chunks, keywordTerms);
      console.log(`\n── Stage 2: Top 15 keyword (BM25-lite) results ──`);
      console.log(`  Terms searched: ${keywordTerms.join(", ")}`);
      if (kwResults.length === 0) {
        console.log(`  ⚠ No keyword matches found — verify that chunk text is indexed correctly`);
      } else {
        for (const { chunk, score, matchedTerms } of kwResults.slice(0, 15)) {
          const lesson  = chunk.lessonNumber !== null ? `lesson=${chunk.lessonNumber}` : "lesson=?";
          const preview = chunk.text.slice(0, 100).replace(/\n/g, " ");
          console.log(`  hits=${score}  src=${chunk.sourceType.padEnd(10)}  ${lesson.padEnd(10)}  ${chunk.id}`);
          console.log(`         matched: [${matchedTerms.join(", ")}]`);
          console.log(`         "${preview}"`);
        }
      }

      // ── Stage 2b: overlap semantic vs keyword ────────────────────────────────
      const semanticTopIds = new Set(allScored.slice(0, 15).map((s) => s.chunk.id));
      const keywordTopIds  = new Set(kwResults.slice(0, 15).map((k) => k.chunk.id));
      const overlap        = [...semanticTopIds].filter((id) => keywordTopIds.has(id));
      console.log(`\n── Stage 2b: Hybrid overlap (semantic top-15 ∩ keyword top-15) ──`);
      if (overlap.length === 0) {
        console.log(`  ⚠ Zero overlap — semantic and keyword retrieval disagree completely`);
      } else {
        console.log(`  ${overlap.length} chunk(s) in both sets: ${overlap.join(", ")}`);
      }
    }

    // ── Apply lexical boost ─────────────────────────────────────────────────
    for (const s of allScored) {
      s.boostedScore = s.rawScore + computeLexicalBoost(s.chunk, topicVariants);
    }
    allScored.sort((a, b) => (b.boostedScore ?? b.rawScore) - (a.boostedScore ?? a.rawScore));

    if (debugLookup) {
      console.log(`\n── Stage 3: Top 15 after lexical boost ──`);
      for (const { chunk, rawScore, boostedScore } of allScored.slice(0, 15)) {
        const lesson = chunk.lessonNumber !== null ? `lesson=${chunk.lessonNumber}` : "lesson=?";
        const boost  = (boostedScore ?? rawScore) - rawScore;
        console.log(`  raw=${rawScore.toFixed(4)}  +boost=${boost.toFixed(4)}  final=${(boostedScore ?? rawScore).toFixed(4)}  src=${chunk.sourceType.padEnd(10)}  ${lesson.padEnd(10)}  ${chunk.id}`);
      }
    }

    // ── Classify top-N ──────────────────────────────────────────────────────
    const topN = debugLookup ? 20 : 14;
    classifiedChunks = pickTopN(allScored, topN)
      .sort((a, b) => (a.chunk.lessonNumber ?? 999) - (b.chunk.lessonNumber ?? 999))
      .map((scored) => {
        const { evidence, reason } = classifyChunk(scored.chunk);
        return { scored, evidence, reason };
      });

    if (debugLookup) {
      // ── Stage 4: classification decisions ──────────────────────────────────
      const lessonEv  = classifiedChunks.filter((c) => c.evidence === "teaching" && c.scored.chunk.lessonNumber !== null);
      const grammarEv = classifiedChunks.filter((c) => c.evidence === "teaching" && c.scored.chunk.lessonNumber === null);
      const incidentalEv = classifiedChunks.filter((c) => c.evidence === "incidental");
      console.log(`\n── Stage 4: Classification of top-${topN} chunks ──`);
      console.log(`  lesson evidence   : ${lessonEv.length}`);
      console.log(`  grammar reference : ${grammarEv.length}`);
      console.log(`  incidental        : ${incidentalEv.length}`);
      for (const { scored: { chunk, rawScore, boostedScore }, evidence, reason } of classifiedChunks) {
        const lesson  = chunk.lessonNumber !== null ? `lesson=${chunk.lessonNumber}` : "lesson=?";
        const final   = (boostedScore ?? rawScore).toFixed(4);
        const verdict = evidence === "teaching" && chunk.lessonNumber !== null ? "LESSON-EV"
                      : evidence === "teaching"                                 ? "GRAMMAR-REF"
                      : "INCIDENTAL";
        console.log(`  [${verdict.padEnd(11)}]  final=${final}  src=${chunk.sourceType.padEnd(10)}  ${lesson.padEnd(10)}  ${chunk.id}  (${reason})`);
      }

      // ── Stage 5: diagnosis ──────────────────────────────────────────────────
      console.log(`\n── Stage 5: Retrieval diagnosis ──`);
      if (lessonEv.length > 0) {
        console.log(`  ✓ LESSON EVIDENCE found → should produce lesson-number answer`);
      } else if (grammarEv.length > 0) {
        console.log(`  ✓ GRAMMAR REFERENCE found → should produce "found in grammar materials, no lesson number" answer`);
      } else if (incidentalEv.length > 0) {
        console.log(`  ⚠ Only INCIDENTAL evidence → should produce "found examples but not the teaching lesson" answer`);
      } else {
        console.log(`  ✗ No relevant evidence in top-${topN} → will answer "couldn't find this"`);
        console.log(`    If keyword search DID find matches, the problem is semantic score too low.`);
        console.log(`    Re-run with: COURSE_LOOKUP_DEBUG=true npx ts-node src/ask.ts "<question>"`);
      }
      console.log(`\n${"═".repeat(60)}\n`);
    } else {
      // Normal (non-debug) summary log
      console.log(`\nLookup type: ${lookupType}`);
      if (topicVariants.length > 0) {
        console.log(`Topic variants: ${topicVariants.join(", ")}`);
      }
      console.log("Chunk classification (ranked by boosted score, ordered by lesson):");
      for (const { scored: { chunk, rawScore, boostedScore }, evidence, reason } of classifiedChunks) {
        const lesson  = chunk.lessonNumber !== null ? `lesson=${chunk.lessonNumber}` : "lesson=?";
        const scores  = `raw=${rawScore.toFixed(4)}  boosted=${(boostedScore ?? rawScore).toFixed(4)}`;
        console.log(`  [${evidence.toUpperCase()}] ${chunk.id}  ${lesson}  src=${chunk.sourceType}  ${scores}  reason: ${reason}`);
      }
    }

    selected = classifiedChunks.map((c) => c.scored);
  } else {
    // Standard mode: lesson filter, then source-type MIX
    const lessonChunks = lessonNumber !== null
      ? allScored.filter((s) => s.chunk.lessonNumber === lessonNumber)
      : [];
    const lessonFilterActive = lessonChunks.length >= 3;

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

    if (lessonNumber !== null && allScored.filter((s) => s.chunk.lessonNumber === lessonNumber).length >= 3) {
      console.log(`Lesson filter applied: lesson ${lessonNumber}`);
    }
  }

  // Print diagnostics
  const grouped = selected.reduce<Record<string, ScoredChunk[]>>((acc, item) => {
    const t = item.chunk.sourceType;
    if (!acc[t]) acc[t] = [];
    acc[t]!.push(item);
    return acc;
  }, {});

  const isLookup = mode === "lookup";
  const retrievedLessons = [...new Set(
    selected.map((s) => s.chunk.lessonNumber).filter((n): n is number => n !== null)
  )].sort((a, b) => a - b);

  console.log(
    `\nMode: ${mode}  |  Intent: ${intent}  |  Difficulty: ${difficulty}  |  Language: ${language}` +
    (lessonNumber !== null ? `  |  Lesson filter: ${lessonNumber}` : ""),
  );
  console.log(`Retrieval-only: ${isLookup ? "YES — context-only prompt, no general knowledge" : "no"}`);
  console.log(`Retrieved lesson numbers: ${retrievedLessons.length > 0 ? retrievedLessons.join(", ") : "(none)"}`);
  console.log("\nSelected chunks:");
  for (const [sourceType, items] of Object.entries(grouped)) {
    console.log(`  [${sourceType}]`);
    for (const { chunk, rawScore } of items) {
      const lesson = chunk.lessonNumber !== null ? ` lesson ${chunk.lessonNumber}` : "";
      console.log(`    ${chunk.id}${lesson}  score: ${rawScore.toFixed(4)}`);
    }
  }

  const context = mode === "lookup" && classifiedChunks !== undefined
    ? buildLookupContext(classifiedChunks)
    : selected
        .map(({ chunk }) => `[${chunk.sourceType} / ${chunk.sourceFile}]\n${chunk.text}`)
        .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(intent, mode, difficulty, language, lookupType);

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
