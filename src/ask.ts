import * as fs from "fs";
import * as path from "path";
import { llm } from "./llm/LlmService";
import { loadConfig } from "./llm/config";
import { appendChatLog, detectFollowUp, getLastEntry } from "./chat-logger";

// ─── Types ────────────────────────────────────────────────────────────────────

type QuestionMode = "practice" | "explanation" | "planning" | "lookup" | "curriculum";
type GrammarIntent = "explanation" | "analysis" | "correction" | "general";
type Difficulty = "easy" | "medium" | "hard";

// ─── Detection keywords ───────────────────────────────────────────────────────

const MODE_KEYWORDS: Record<QuestionMode, string[]> = {
  practice:    ["practice", "drill", "exercise", "quiz", "write", "fill", "repeat", "תרגיל", "תרגול"],
  planning:    ["plan", "schedule", "syllabus"],
  explanation: ["explain", "what is", "how does", "meaning"],
  // lookup and curriculum detection are handled by their own functions — keywords unused
  lookup:      [],
  curriculum:  [],
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
  // lookup and curriculum bypass MIX entirely
  lookup:      { summary: 0, lesson: 0, vocab: 0, workbook: 0, genki: 0, unknown: 0 },
  curriculum:  { summary: 0, lesson: 0, vocab: 0, workbook: 0, genki: 0, unknown: 0 },
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

// Grounding constraint — injected into every mode that can reference lesson content.
// Prevents the model from describing lessons not present in the retrieved context.
const GROUNDING_RULES = `
Evidence grounding — always follow:
- LESSON CONTENT: Only describe what a specific lesson covers if that lesson's chunks appear in the retrieved context. Do not describe lesson topics, structure, or content from training knowledge.
- LESSON NUMBERS: Only recommend or mention specific lesson numbers that appear in the retrieved context. Do not recall lesson numbers from training data.
- MISSING LESSONS: If a lesson is not represented in the retrieved context, do not describe its content. You may acknowledge it exists (e.g., "Lesson 12 covers te-form") but say nothing about what it contains beyond that.
- DISTINGUISH SOURCES: Be explicit about what the retrieved context shows versus what you are inferring versus what you cannot determine because it was not retrieved.
- CIRCULAR RECOMMENDATIONS: Never recommend a lesson as preparation for itself. If a question asks what to review before topic X and topic X is taught in Lesson N, do not recommend Lesson N as a prerequisite.
- UNSUPPORTED CLAIMS: If you cannot find supporting evidence in the context for a specific claim about a lesson, say "I don't have retrieved evidence for that lesson" rather than filling in from general knowledge.
`;

const GROUNDING_RULES_HE = `
עיגון בראיות — חובה לפעול לפי כללים אלה:
- תוכן שיעור: תאר מה מכסה שיעור מסוים רק אם קטעי השיעור מופיעים בהקשר שנשלף. אסור לתאר תוכן שיעור מידע כללי.
- מספרי שיעור: ציין מספרי שיעור ספציפיים רק אם הם מופיעים בהקשר שנשלף. אסור להיזכר במספרי שיעור מידע אימון.
- שיעורים חסרים: אם שיעור אינו מיוצג בהקשר שנשלף, אל תתאר את תוכנו. תוכל לציין שהוא קיים אך אל תוסיף מה הוא מכסה.
- הבחן בין מקורות: ציין מה ההקשר מראה לעומת מה שאתה מסיק לעומת מה שאינך יכול לדעת כי לא נשלף.
- המלצות מעגליות: אסור להמליץ על שיעור כהכנה לאותו שיעור עצמו.
- טענות לא מגובות: אם אינך מוצא ראיות בהקשר לטענה על שיעור ספציפי, אמור "אין לי ראיות שנשלפו לשיעור זה" במקום למלא מידע כללי.
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

  // "where is this/it/that explained/covered/found"
  /\bwhere\s+(is|was)\s+(this|it|that)\s+(explained|covered|taught|found)\b/i,

  // "where is X explained/covered/found" — topic is a noun phrase, not a pronoun
  // e.g. "where is は vs が explained?", "where is the te-form covered?"
  /\bwhere\s+(is|are|was|were)\s+.{1,60}\b(explained|covered|taught|found|mentioned|introduced)\b/i,

  // "where does X appear" — e.g. "where does the te-form appear in the workbook?"
  /\bwhere\s+does\s+.{0,60}\bappear\b/i,

  // "in the workbook" / "in the exercises" — location lookup
  /\bin\s+(the\s+)?workbook\b/i,
  /\bin\s+(the\s+)?exercises?\b/i,

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

  // "do my/your/the materials explain/cover/contain/include X?"
  /\bdo\s+(?:my|your|the|our)\s+materials?\s+(?:explain|cover|contain|include|mention|address|discuss)\b/i,

  // "does my/your/the course/workbook/textbook explain/cover X?"
  /\bdoes\s+(?:my|your|the|our)\s+(?:course|workbook|textbook|material)\s+(?:explain|cover|contain|include|mention)\b/i,

  // "do my/your materials X" — catch remaining verb forms
  /\bdo\s+(?:my|your|the|our)\s+(?:course\s+)?materials?\b/i,

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

// ─── Curriculum intent detection ──────────────────────────────────────────────
//
// Curriculum questions ask about course structure: which lesson introduces a
// topic, what is covered in a given lesson, what to review beforehand.
// These are distinct from lookup (topic-in-materials) and grammar explanations.

type CurriculumQueryType = "first-introduces" | "lesson-topics" | "review-before" | "generic";

const CURRICULUM_PATTERNS: RegExp[] = [
  // "first introduces/covers/teaches X"
  /\bfirst\s+(introduces?|covered?|taught|appears?|explains?)\b/i,

  // "what/which lesson introduces X"
  /\b(what|which)\s+(lesson|class|unit)\s+.{0,40}\bintroduces?\b/i,

  // "main topics / what is covered in lesson N"
  /\b(main\s+)?topics?\s+(covered\s+)?(in|of)\s+(lesson|class)\b/i,
  /\bwhat\s+(is|are|was|were)\s+(covered|taught|introduced)\s+in\s+lesson\b/i,
  /\bcovered\s+in\s+lesson\s+\d+\b/i,
  /\bwhat\s+(do\s+we\s+)?learn\s+in\s+lesson\b/i,

  // "review before lesson N" / "prepare for lesson N"
  /\b(review|study|prepare)\s+(before|for)\s+(lesson|class)\s*\d+\b/i,

  // "where do we learn X" / "where is X taught" (not already caught by lookup)
  /\bwhere\s+(do\s+we|is|are)\s+.{0,50}\b(learn|taught|introduced)\b/i,

  // Hebrew
  /מה\s+לומדים\s+בשיעור/,
  /מה\s+מכוסה\s+בשיעור/,
  /מתי\s+לומדים/,
  /איפה\s+לומדים/,
  /על\s+מה\s+לחזור\s+לפני/,
  /איזה\s+שיעור\s+מציג/,
];

function detectCurriculumIntent(question: string): boolean {
  return CURRICULUM_PATTERNS.some((re) => re.test(question));
}

function detectCurriculumQueryType(question: string): CurriculumQueryType {
  if (/\bfirst\s+(introduces?|covered?|taught|appears?|explains?)\b/i.test(question)) {
    return "first-introduces";
  }
  if (
    /\b(review|study|prepare)\s+(before|for)\s+(lesson|class)\s*\d+\b/i.test(question) ||
    /על\s+מה\s+לחזור\s+לפני/.test(question)
  ) {
    return "review-before";
  }
  if (
    /\b(main\s+)?topics?\s+(covered\s+)?(in|of)\s+(lesson|class)\b/i.test(question) ||
    /\bwhat\s+(is|are|was|were)\s+(covered|taught|introduced)\s+in\s+lesson\b/i.test(question) ||
    /\bcovered\s+in\s+lesson\s+\d+\b/i.test(question) ||
    /\bwhat\s+(do\s+we\s+)?learn\s+in\s+lesson\b/i.test(question) ||
    /מה\s+לומדים\s+בשיעור/.test(question) ||
    /מה\s+מכוסה\s+בשיעור/.test(question)
  ) {
    return "lesson-topics";
  }
  return "generic";
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
  // Curriculum — course-structure questions not caught by lookup patterns
  if (detectCurriculumIntent(question)) return "curriculum";
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
  { pattern: /は\s*(?:vs?|and|versus)\s*が|\bwa\s*(?:vs?|and|versus)\s*ga\b/i,     key: "particles-wa-ga" },
  { pattern: /\bparticle\s+は\b|\bは\s+particle\b|\btopic\s+(?:marker|particle)\b/i, key: "particle-wa" },
  { pattern: /\bparticle\s+が\b|\bが\s+particle\b|\bsubject\s+(?:marker|particle)\b/i, key: "particle-ga" },
  { pattern: /\bparticle\s+を\b|\bを\s+particle\b|\b(?:wo|direct\s+object\s+marker)\b/i, key: "particle-wo" },
  { pattern: /に\s*(?:vs?|and|versus)\s*で|\bni\s*(?:vs?|and|versus)\s*de\b/i,     key: "particles-ni-de" },
  { pattern: /\bparticle\s+に\b|\bに\s+particle\b|\bni\s+(?:particle|direction|destination)\b/i, key: "particle-ni" },
  { pattern: /\bparticle\s+で\b|\bで\s+particle\b|\bde\s+(?:particle|location|action)\b/i, key: "particle-de" },
  { pattern: /\bparticle\s+と\b|\bと\s+particle\b/i,                              key: "particle-to" },
  { pattern: /\bparticle\s+の\b|\bの\s+particle\b|\bpossession\s+の\b/i,           key: "particle-no" },
  { pattern: /\bparticle\s+も\b|\bも\s+particle\b/i,                              key: "particle-mo" },
  { pattern: /\bna[-\s]?adjective[s]?\b|\bな[-\s]?形容詞\b/i,                     key: "na-adjectives" },
  { pattern: /\bi[-\s]?adjective[s]?\b|\bい[-\s]?形容詞\b/i,                      key: "i-adjectives" },
  { pattern: /\bます\s*(?:form)?\b|\bpolite\s+form\b|\bmasu\s+form\b/i,           key: "masu-form" },
  { pattern: /\bnegative\s+verb\b|\bverb\s+negati(?:on|ve)\b|\bnegative\s+form\s+of\s+verb[s]?\b/i, key: "negative-verb-form" },
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

// ─── Negation-type-aware context builder ─────────────────────────────────────
//
// The "negative-form" topic index entry mixes four distinct negation types:
//   verb negation  (ません/ませんでした)      — Lessons 5, 8
//   copula negation (じゃないです/じゃありません) — Lesson 2
//   i-adjective negation (くない/くありません) — Lesson 10
//   suki/na-adj negation (すきじゃない)        — Lesson 11
//
// When the user asks specifically about verb negation, this function:
//   (a) presents verb-negation chunks first
//   (b) labels other types as RELATED BUT DISTINCT
//   (c) prepends an explicit instruction to the model context

type NegationType = "verb" | "copula" | "adjective" | "suki" | "incidental";

function getNegationType(match: TopicIndexMatch): NegationType {
  const aliases = match.matchedAliases;
  // Explicit "negative verb" alias only appears in Lesson 5 and 8 chunks
  if (aliases.includes("negative verb") || aliases.includes("verb negation")) return "verb";
  const ln = match.lessonNumber;
  if (ln === 5 || ln === 8) return "verb";
  if (ln === 10) return "adjective";
  if (ln === 11) return "suki";
  if (ln === 2 && (aliases.includes("ない") || aliases.includes("negative form") || aliases.includes("じゃない"))) return "copula";
  return "incidental";
}

function buildNegationTopicContext(
  entry: TopicIndexEntry,
  lookupType: LookupType,
  verbSpecific: boolean,
): string {
  const dedup = (matches: TopicIndexMatch[]): TopicIndexMatch[] => {
    const seen = new Set<number>();
    return matches.filter((m) => {
      if (m.lessonNumber === null) return true;
      if (seen.has(m.lessonNumber)) return false;
      seen.add(m.lessonNumber);
      return true;
    });
  };

  const fmtMatch = (m: TopicIndexMatch): string => {
    const tag = m.lessonNumber !== null ? `Lesson ${m.lessonNumber}` : "No lesson number";
    return `[${tag} / ${m.sourceType} / ${m.sourceFile}]\n${m.excerpt}`;
  };

  const classified = {
    verb:       dedup(entry.matches.filter((m) => getNegationType(m) === "verb")),
    copula:     dedup(entry.matches.filter((m) => getNegationType(m) === "copula")),
    adjective:  dedup(entry.matches.filter((m) => getNegationType(m) === "adjective")),
    suki:       dedup(entry.matches.filter((m) => getNegationType(m) === "suki")),
  };

  const lines: string[] = [];

  if (verbSpecific) {
    lines.push(
      "=== INSTRUCTION: The user asked specifically about VERB negation (ません/ませんでした). ===",
      "=== Prioritise verb negation below. If you mention adjective/suki negation, label it explicitly as a RELATED BUT DISTINCT type. ===",
      "",
    );
  }

  const relPrefix = verbSpecific ? "RELATED BUT DISTINCT — " : "";

  if (classified.verb.length > 0) {
    lines.push(`=== VERB NEGATION — ません / ませんでした ("does not do", "did not do") ===\n`);
    lines.push(classified.verb.map(fmtMatch).join("\n\n---\n\n"));
  } else {
    lines.push("=== VERB NEGATION ===\n\n(no explicit teaching found in lesson evidence)");
  }

  if (classified.copula.length > 0) {
    lines.push(`\n=== ${relPrefix}COPULA / NOUN NEGATION — じゃないです / じゃありません ("is not [noun]") ===\n`);
    lines.push(classified.copula.map(fmtMatch).join("\n\n---\n\n"));
  }

  if (classified.adjective.length > 0) {
    lines.push(`\n=== ${relPrefix}I-ADJECTIVE NEGATION — くないです / くありません ("not [adjective]") ===\n`);
    lines.push(classified.adjective.map(fmtMatch).join("\n\n---\n\n"));
  }

  if (classified.suki.length > 0) {
    lines.push(`\n=== ${relPrefix}SUKI / NA-ADJECTIVE NEGATION — すきじゃない / きれいじゃない ===\n`);
    lines.push(classified.suki.map(fmtMatch).join("\n\n---\n\n"));
  }

  const lessonNumbers = entry.summary.lessonNumbers;
  lines.push(
    `\n[Topic index summary: found in lessons ${lessonNumbers.join(", ")}; total matches: ${entry.summary.totalMatches}]`,
  );

  return lines.join("\n");
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
    pattern: /\bnegative\s+verb\b|\bverb\s+negati(?:on|ve)\b|\bnegative\s+form\s+of\s+verb[s]?\b/i,
    terms: ["negative verb form", "ません verb negation", "does not do", "masen form", "verb conjugation negative", "ません ませんでした"],
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

// ─── Curriculum retrieval ─────────────────────────────────────────────────────

// Broader topic aliases for searching summary chunk text.
// These are shorter/simpler than GRAMMAR_EXPANSIONS because summary chunks use
// natural prose like "The particle で" rather than embedding-friendly phrases.
const CURRICULUM_TOPIC_EXPANSIONS: { pattern: RegExp; aliases: string[] }[] = [
  { pattern: /\badjectives?\b/i,
    aliases: ["adjective", "adjectives", "けいようし", "i-adjective", "na-adjective", "形容詞"] },
  { pattern: /\bte[-\s]?form\b|\bて[-\s]?form\b|て形/i,
    aliases: ["te-form", "て form", "て-form", "て形", "te form"] },
  { pattern: /\bparticle\s+で\b|\bで\s+particle\b|\bde\s+particle\b/i,
    aliases: ["で", "particle で", "de particle", "location", "place of action"] },
  { pattern: /\bparticle\s+に\b|\bに\s+particle\b|\bni\s+particle\b/i,
    aliases: ["に", "particle に", "ni particle", "direction", "destination"] },
  { pattern: /\bparticle\s+は\b|\bは\s+particle\b|\btopic\s+(?:marker|particle)\b/i,
    aliases: ["は", "wa particle", "topic marker", "topic particle"] },
  { pattern: /\bparticle\s+が\b|\bが\s+particle\b|\bsubject\s+(?:marker|particle)\b/i,
    aliases: ["が", "ga particle", "subject marker"] },
  { pattern: /\bparticle\s+を\b|\bを\s+particle\b|\bdirect\s+object\b/i,
    aliases: ["を", "wo particle", "direct object"] },
  { pattern: /\bparticle\s+と\b|\bと\s+particle\b/i,
    aliases: ["と", "to particle", "list"] },
  { pattern: /\bparticle\s+の\b|\bの\s+particle\b|\bpossession\b/i,
    aliases: ["の", "no particle", "possession"] },
  { pattern: /\bparticle\s+へ\b|\bへ\s+particle\b/i,
    aliases: ["へ", "he particle", "direction"] },
  { pattern: /\bgreetings?\b/i,
    aliases: ["greeting", "greetings", "こんにちは", "おはよう"] },
  { pattern: /\bpast\s+tense\b|\bました\b|\bmashita\b/i,
    aliases: ["past tense", "ました", "past"] },
  { pattern: /\bnegative\s+(?:form|verb)?\b|\bません\b|\bmasen\b/i,
    aliases: ["negative", "ません", "ない", "masen"] },
  { pattern: /\bmasu\s+form\b|\bpolite\s+form\b|\bます\b/i,
    aliases: ["ます", "masu", "polite form"] },
  { pattern: /\bexistence\s+verb[s]?\b|\bimasu\b|\barimasu\b|\bいます\b|\bあります\b/i,
    aliases: ["existence verb", "います", "あります", "iru", "aru"] },
  { pattern: /\bfrequency\b|\bfrequency\s+adverb[s]?\b/i,
    aliases: ["frequency", "adverb", "いつも", "よく", "ときどき"] },
  { pattern: /\bdemonstratives?\b|\bkore\b|\bsore\b|\bkono\b|\bこれ\b|\bそれ\b/i,
    aliases: ["demonstrative", "これ", "それ", "kore", "sore", "kono"] },
  { pattern: /\bhiragana\b/i,
    aliases: ["hiragana", "ひらがな"] },
  { pattern: /\bkatakana\b/i,
    aliases: ["katakana", "カタカナ"] },
  { pattern: /\btelling\s+time\b|\btime\s+expression[s]?\b/i,
    aliases: ["time", "telling time", "時"] },
  { pattern: /\bdirection[s]?\b|\binvitation[s]?\b/i,
    aliases: ["direction", "invitation", "ませんか", "ましょう"] },
  { pattern: /\bself.?introduction\b|\bintroduce\s+yourself\b/i,
    aliases: ["self introduction", "自己紹介", "はじめまして"] },
  { pattern: /\bnumber[s]?\b|\bcounting\b|\bcounter[s]?\b/i,
    aliases: ["number", "counting", "counter", "一", "二", "三"] },
  { pattern: /\bsentence\s+structure\b|\bword\s+order\b|\bSOV\b/i,
    aliases: ["sentence structure", "word order", "SOV"] },
  // Hebrew topic patterns
  { pattern: /פועל[ים]?/,   aliases: ["verb", "verbs", "ます", "te form"] },
  { pattern: /חלקיק[ים]?/,  aliases: ["particle", "は", "が", "を", "に", "で"] },
  { pattern: /שלילה/,       aliases: ["negative", "ません", "ない"] },
  { pattern: /עבר/,         aliases: ["past tense", "ました"] },
];

function extractCurriculumAliases(question: string): string[] {
  const aliases: string[] = [];

  for (const { pattern, aliases: terms } of CURRICULUM_TOPIC_EXPANSIONS) {
    if (pattern.test(question)) aliases.push(...terms);
  }

  // Include any Japanese characters written directly in the question
  const japanese = question.match(/[ぁ-ゟ゛-ゞァ-ヿ一-鿿]+/g) ?? [];
  aliases.push(...japanese);

  // Extract "particle X" / "the particle X" where X is a short symbol
  const particleMatch = question.match(/particle\s+([^\s,?!.()]{1,4})/i);
  if (particleMatch) {
    const p = particleMatch[1]!.replace(/[?.,!]/g, "");
    if (p.length >= 1) aliases.push(p, `particle ${p}`, `${p} particle`);
  }

  return [...new Set(aliases)].filter((a) => a.length >= 1);
}

// ─── CourseIndex ──────────────────────────────────────────────────────────────
//
// Deterministic inverted index built from summary chunks at startup.
// Aliases are pre-indexed so lookup() requires no embeddings.

interface CourseIndexResult {
  chunks: EmbeddedChunk[];
  matchedAliases: string[];
  matchedLessons: number[];
}

class CourseIndex {
  private readonly byLesson = new Map<number, EmbeddedChunk[]>();
  // Tier 1: alias found in the "## Main Topics" section of the overview chunk (high precision)
  private readonly mainTopicsAliasMap = new Map<string, Set<number>>();
  // Tier 2: alias found anywhere in the lesson's summary chunks (broader fallback)
  private readonly bodyAliasMap       = new Map<string, Set<number>>();
  readonly lessonCount: number;

  constructor(allChunks: EmbeddedChunk[]) {
    // Group summary chunks by lesson, sorted by chunkIndex (doc order)
    for (const chunk of allChunks) {
      if (chunk.sourceType !== "summary" || chunk.lessonNumber === null) continue;
      const ln = chunk.lessonNumber;
      if (!this.byLesson.has(ln)) this.byLesson.set(ln, []);
      this.byLesson.get(ln)!.push(chunk);
    }
    for (const chunks of this.byLesson.values()) {
      chunks.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
    }
    this.lessonCount = this.byLesson.size;

    for (const [lesson, chunks] of this.byLesson.entries()) {
      // Tier 1: index only the "## Main Topics" section of the overview chunk
      const overview = chunks[0];
      const mainTopicsText = overview
        ? CourseIndex.extractMainTopics(overview.text)
        : "";

      // Tier 2: full text of all summary chunks for this lesson
      const fullText = CourseIndex.normalize(chunks.map((c) => c.text).join("\n"));

      for (const { aliases } of CURRICULUM_TOPIC_EXPANSIONS) {
        for (const alias of aliases) {
          const normAlias = CourseIndex.normalize(alias);
          if (normAlias.length < 1) continue;

          if (mainTopicsText.includes(normAlias)) {
            if (!this.mainTopicsAliasMap.has(normAlias))
              this.mainTopicsAliasMap.set(normAlias, new Set());
            this.mainTopicsAliasMap.get(normAlias)!.add(lesson);
          }

          if (fullText.includes(normAlias)) {
            if (!this.bodyAliasMap.has(normAlias))
              this.bodyAliasMap.set(normAlias, new Set());
            this.bodyAliasMap.get(normAlias)!.add(lesson);
          }
        }
      }
    }
  }

  // Lowercase English, preserve Japanese, collapse punctuation to spaces.
  static normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[・、。！？「」（）【】《》〈〉]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Extract and normalize the "## Main Topics" section from an overview chunk.
  private static extractMainTopics(text: string): string {
    const m = text.match(/##\s+Main\s+Topics([\s\S]*?)(?=\n##|\n#|$)/i);
    const raw = m ? m[1]! : text.slice(0, 600);
    return CourseIndex.normalize(raw);
  }

  // All summary chunks for a specific lesson, in document order.
  forLesson(lesson: number): EmbeddedChunk[] {
    return this.byLesson.get(lesson) ?? [];
  }

  // Lessons that match any alias, preferring Main Topics matches.
  // Returns lessons present in main-topics tier if any exist; otherwise falls
  // back to body-text tier. This prevents "で" from matching every lesson just
  // because the character appears incidentally in body text.
  private matchingLessons(aliases: string[]): Map<number, string[]> {
    const mainMatches = new Map<number, string[]>();
    const bodyMatches = new Map<number, string[]>();

    for (const alias of aliases) {
      const normAlias = CourseIndex.normalize(alias);

      for (const lesson of this.mainTopicsAliasMap.get(normAlias) ?? []) {
        if (!mainMatches.has(lesson)) mainMatches.set(lesson, []);
        mainMatches.get(lesson)!.push(alias);
      }
      for (const lesson of this.bodyAliasMap.get(normAlias) ?? []) {
        if (!bodyMatches.has(lesson)) bodyMatches.set(lesson, []);
        bodyMatches.get(lesson)!.push(alias);
      }
    }

    // Prefer main-topics tier; fall back to body tier only if nothing in main
    return mainMatches.size > 0 ? mainMatches : bodyMatches;
  }

  // Select chunks appropriate for the query type.
  select(
    queryType: CurriculumQueryType,
    aliases: string[],
    targetLesson: number | null,
  ): CourseIndexResult | null {

    // ── lesson-topics: all chunks for the specified lesson ─────────────────
    if (queryType === "lesson-topics" && targetLesson !== null) {
      const chunks = this.forLesson(targetLesson).slice(0, 10);
      if (chunks.length > 0) {
        return { chunks, matchedAliases: [], matchedLessons: [targetLesson] };
      }
      return null;
    }

    // ── review-before: summary chunks for the two preceding lessons ────────
    if (queryType === "review-before" && targetLesson !== null) {
      const prev = [targetLesson - 1, targetLesson - 2].filter((l) => l >= 1);
      const chunks = prev.flatMap((l) => this.forLesson(l).slice(0, 5));
      if (chunks.length > 0) {
        return { chunks, matchedAliases: [], matchedLessons: prev };
      }
      return null;
    }

    // ── alias-based lookup (first-introduces / generic) ────────────────────
    const lessonAliasMap = this.matchingLessons(aliases);
    if (lessonAliasMap.size === 0) return null;

    // Sort lessons ascending so the earliest lesson appears first
    const sorted = [...lessonAliasMap.entries()].sort((a, b) => a[0] - b[0]);
    const matchedLessons  = sorted.map(([l]) => l);
    const matchedAliases  = [...new Set(sorted.flatMap(([, a]) => a))];

    if (queryType === "first-introduces") {
      // Earliest lesson's chunks (overview first) + next 2 lessons' overviews for context
      const [firstLesson, ...rest] = sorted;
      const chunks = [
        ...this.forLesson(firstLesson![0]).slice(0, 4),
        ...rest.slice(0, 2).flatMap(([l]) => this.forLesson(l).slice(0, 1)),
      ];
      return { chunks, matchedAliases, matchedLessons };
    }

    // Generic: overview chunks for each matching lesson
    const chunks = sorted.flatMap(([l]) => this.forLesson(l).slice(0, 2)).slice(0, 10);
    return { chunks, matchedAliases, matchedLessons };
  }
}

function buildCurriculumContext(
  result: CourseIndexResult,
  queryType: CurriculumQueryType,
): string {
  const fmt = (chunk: EmbeddedChunk): string => {
    const tag = chunk.lessonNumber !== null ? `Lesson ${chunk.lessonNumber}` : "No lesson number";
    return `[${tag} / ${chunk.sourceType} / ${chunk.sourceFile}]\n${chunk.text}`;
  };

  const header =
    queryType === "first-introduces" ? "=== COURSE INDEX — sorted by lesson number ascending (earliest first) ===" :
    queryType === "lesson-topics"    ? "=== COURSE INDEX — lesson content ===" :
    queryType === "review-before"    ? "=== COURSE INDEX — prerequisite lessons ===" :
                                       "=== COURSE INDEX ===";

  const aliasLine = result.matchedAliases.length > 0
    ? `Aliases matched: ${result.matchedAliases.join(", ")}\n\n`
    : "";
  const lessonLine = result.matchedLessons.length > 0
    ? `Lessons found: ${result.matchedLessons.join(", ")}\n\n`
    : "";

  return `${header}\n\n${aliasLine}${lessonLine}${result.chunks.map(fmt).join("\n\n---\n\n")}`;
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

  // ── Curriculum mode: answer from course index/summary chunks only ──────────
  if (mode === "curriculum") {
    if (language === "hebrew") {
      return `${lang}
אתה עוזר מדריך קורס. ענה אך ורק על בסיס אינדקס הקורס שסופק — אין להשתמש בידע יפנית כללי.

כללים:
- אל תסביר דקדוק — רק דווח מה מוצג ובאיזה שיעור.
- אם מצאת ראיות ברורות: "שיעור X מציג את [נושא]."
- אם אינך בטוח: "לפי אינדקס הקורס, נראה שזה מוצג בשיעור X."
- אם אין ראיות: "לא מצאתי ראיות לכך באינדקס הקורס."
- אל תמציא מספרי שיעורים.
- לשאלה על מה מכוסה בשיעור X — רשום את הנושאים הראשיים מהסיכום.
- לשאלה על מה לחזור לפני שיעור X — רשום את הנושאים העיקריים מהשיעורים הקודמים.`;
    }
    return `You are a course index assistant.
Answer ONLY from the retrieved course index / summary chunks. Do NOT use general Japanese knowledge.

Rules:
- Do not explain grammar — only report what is covered and in which lesson.
- If clear evidence exists: state "Lesson X introduces [topic]."
- If uncertain: state "Based on the course index, it appears to be introduced in Lesson X."
- If no evidence: state "I couldn't find evidence of this in the course index."
- Do not invent lesson numbers.
- For "what is covered in lesson X": list the main topics from the summary chunks provided.
- For "review before lesson X": list the main topics from the preceding lesson summaries provided.
- Only list prerequisites that are represented in the retrieved context. Do not add lessons from general knowledge.
- Never recommend a lesson as a prerequisite for itself.
${GROUNDING_RULES}`;
  }

  // ── Lookup mode: only answer from retrieved context ────────────────────────
  if (mode === "lookup") {
    const isTeachingQuery = (lookupType ?? "teaching") === "teaching";

    if (language === "hebrew") {
      const teachingRule = isTeachingQuery
        ? `כללי תשובה לשאלת חיפוש-הוראה (לפי סדר עדיפות):
1. אם "ראיות שיעור" מכילות מספר שיעור:
   - פתח בתשובה ישירה: "כן, נושא זה מופיע בשיעור X[ ובשיעור Y]."
   - לאחר מכן פרט כל שיעור בשורה נפרדת: "שיעור X — [משפט אחד רגיל המסכם מה השיעור אומר על הנושא]"
   - אל תציג טבלאות markdown — סכם תוכן טבלאות במשפט רגיל.
2. אם רק "חומר עזר דקדוקי" מכיל את הנושא (ללא מספר שיעור) — ענה:
   "מצאתי את הנושא בחומרי העזר הדקדוקיים, אך הוא אינו משויך לשיעור ממוספר."
3. אם רק "ראיות אינצידנטליות" מכילות את הנושא — ענה:
   "מצאתי דוגמאות לכך בחומרים, אבל לא מצאתי את השיעור שבו זה נלמד רשמית."
4. אם אין ראיות כלל — ענה: "לא מצאתי את זה בחומרי הקורס המאונדקסים."

אסור להמציא מספרי שיעור. אסור להסיק מספר שיעור מהקשר אינצידנטלי בלבד.`
        : `- פתח בתשובה ישירה כן/לא לשאלה.
- לאחר מכן ציין את כל המקומות שבהם הנושא מופיע — בשיעורים, בחומר עזר, ובתרגילים.
- לכל מיקום כתוב משפט אחד רגיל המסכם מה החומר אומר.
- אם אין ראיות כלל — אמור: "לא מצאתי את זה בחומרי הקורס המאונדקסים."`;

      return `${lang}
אתה עוזר חיפוש בחומרי הקורס. ענה רק מהקטעים שסופקו — אסור להשתמש בידע יפנית כללי.

ההקשר מחולק לשלושה חלקים:
  ראיות שיעור      — שיעורים עם מספר שיעור ידוע (הרמה הגבוהה ביותר).
  חומר עזר דקדוקי — דקדוק/סיכום ללא מספר שיעור (הנושא מוסבר אך לא שויך לשיעור).
  ראיות אינצידנטליות — חוברת עבודה/תרגילים (הנושא מופיע כדוגמה בלבד).

${teachingRule}

חשוב: אסור לכתוב טקסט-מציין-מיקום כמו [ציטוט קצר], [excerpt], [quote here], או כל טקסט בסוגריים מרובעים במקום תוכן אמיתי. כתוב משפטים רגילים המבוססים על הטקסט שנשלף, או השמט לחלוטין.`;
    }

    const teachingRule = isTeachingQuery
      ? `Answer rules for a teaching-lookup query (apply in priority order):
1. If LESSON EVIDENCE contains the topic with a lesson number:
   - Start with a direct answer: "Yes, this is covered in Lesson X[ and Lesson Y]." (or "No, I couldn't find this in the course materials." if nothing found)
   - Then list each lesson on its own line: "Lesson X — [one plain sentence summarising what that lesson says about the topic, based on the retrieved text]"
   - If multiple lessons cover it, list each one.
2. If only GRAMMAR REFERENCE contains the topic (no lesson number):
   "I found this topic in the grammar reference materials, but it isn't tied to a specific lesson number."
3. If only INCIDENTAL APPEARANCES contain the topic:
   "I found examples of this in the materials, but I couldn't find the lesson where it is explicitly taught."
4. If none of the sections mention the topic:
   "I couldn't find this in the indexed course materials."

Do NOT invent lesson numbers. Do NOT infer a lesson number from incidental or grammar-reference evidence.
Do NOT describe a lesson's content unless that lesson's chunks are present in the retrieved context above. Only summarize what the retrieved chunk actually says — do not add content from training knowledge.
Do NOT output raw markdown tables from the retrieved text — summarise table content as a plain sentence instead.
${GROUNDING_RULES}`
      : `- Start with a direct yes/no answer to the question.
- Then report all locations where the topic appears — lesson, grammar reference, and incidental.
- For each location write one plain sentence summarising what the material says.
- If none of the sections mention the topic, respond with:
  "I couldn't find this in the indexed course materials."`;

    return `You are a course material search assistant.
Answer ONLY from the retrieved excerpts. Do NOT use your general Japanese knowledge.

The context is split into three sections:
  LESSON EVIDENCE       — chunks from numbered lessons (highest confidence for lesson mapping).
  GRAMMAR REFERENCE     — grammar/summary chunks without a lesson number (topic is explained but not lesson-tagged).
  INCIDENTAL APPEARANCES — workbook/exercise chunks (topic appears as example only).

${teachingRule}

IMPORTANT: Never output placeholder text such as [short quote], [excerpt], [quote here], or any text in square brackets as a substitution for real content. Write plain sentences based on the retrieved text, or omit if nothing fits.`;
  }

  const base       = `${OUTPUT_RULES}${GRAMMAR_ACCURACY_RULES}${TEACHING_STYLE}`;
  const hebrewBase = `${OUTPUT_RULES}${HEBREW_BASE_RULES}${TEACHING_STYLE_HE}`;

  if (intent === "explanation") {
    if (language === "hebrew") {
      return `${lang}
${hebrewBase}
${GROUNDING_RULES_HE}
אתה מורה דקדוק יפני ידידותי למתחילים.

חוקים:
- להסברי דקדוק (איך חלקיקים עובדים, הטיות, תבניות משפט): הסבר מידיעתך גם אם ההקשר חלקי.
- לתוכן שיעור ספציפי (מה שיעור X מכסה, איזה שיעור מציג נושא, מה לחזור לפני שיעור): השתמש רק בשיעורים ותוכן שיעור המופיעים בהקשר שנשלף. אסור להיזכר במבנה הקורס מידע אימון.
- אל תפיק רשימות אוצר מילים אלא אם נשאלת במפורש.
- ענה רק על השאלה שנשאלה.
- אם ההקשר מספק מידע רלוונטי — השתמש בו.
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
${GROUNDING_RULES}
You are a beginner-friendly Japanese grammar tutor.

Rules:
- For GRAMMAR EXPLANATIONS (how particles work, how to conjugate, grammar patterns): explain clearly using general Japanese knowledge even if context is incomplete.
- For LESSON-SPECIFIC CONTENT (what a particular lesson covers, which lesson introduces a topic, lesson prerequisites): only reference lessons and lesson content that appear in the retrieved context above. Do not recall course structure or lesson numbering from training data.
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
${GROUNDING_RULES_HE}
אתה מורה יפנית ידידותי. ענה על השאלה בעברית בצורה ברורה ומועילה.
- להסברי דקדוק: ענה מידיעתך כמורה.
- לשאלות על תוכן שיעור או מספרי שיעור: השתמש רק בהקשר שנשלף.`;
  }
  return `${lang}
${base}
${GROUNDING_RULES}
You are a helpful Japanese teacher. Answer the question clearly.
- For grammar explanations: answer from your knowledge as a teacher.
- For lesson-specific content or lesson number recommendations: use only the retrieved context above.`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error("Usage: ts-node src/ask.ts <your question>");
    process.exit(1);
  }

  // Fail fast with a clear message if the LLM server is unreachable.
  try {
    await llm.healthCheck();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const llmConfig = await loadConfig();
  const interactionStart = Date.now();
  const isFollowUp = detectFollowUp(question);
  const previousLogEntry = isFollowUp ? getLastEntry() : null;

  const embeddingsPath = path.join(process.cwd(), "data", "all-embeddings.json");
  if (!fs.existsSync(embeddingsPath)) {
    console.error("Embeddings file not found:", embeddingsPath);
    process.exit(1);
  }

  const chunks: EmbeddedChunk[] = JSON.parse(fs.readFileSync(embeddingsPath, "utf-8"));

  // Build deterministic course index from summary chunks (no embeddings required)
  const courseIndex = new CourseIndex(chunks);

  // Detect mode first so lookup can expand the query before embedding
  const intent       = detectIntent(question);
  const mode         = detectMode(question);
  const difficulty   = detectDifficulty(question);
  const lessonNumber = detectLessonNumber(question);
  const language     = detectLanguage(question);
  const lookupType   = mode === "lookup" ? detectLookupType(question) : undefined;

  // useCurriculumPath: true when mode is "curriculum" OR when mode is "lookup"
  // but the topic index misses AND the question has curriculum intent.
  // Set to false initially; lookup block may flip it to true on a miss.
  let useCurriculumPath = mode === "curriculum";

  // ── Topic index early-return (lookup mode only) ──────────────────────────
  // Query the pre-built topic index before touching embeddings. If the question
  // maps to a known grammar topic, we can answer directly from exact-match data.
  const debugLookupEarly = mode === "lookup" && process.env.COURSE_LOOKUP_DEBUG === "true";

  if (mode === "lookup") {
    const topicIndex = loadTopicIndex();
    const topicKey   = topicIndex ? detectTopicKey(question) : null;
    // "negative-verb-form" is a refined key — the index stores it under "negative-form"
    const resolvedKey = topicKey === "negative-verb-form" ? "negative-form" : topicKey;
    const topicEntry = resolvedKey && topicIndex ? topicIndex[resolvedKey] : undefined;

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
      const isNegationTopic = topicKey === "negative-form" || topicKey === "negative-verb-form";
      const context = isNegationTopic
        ? buildNegationTopicContext(topicEntry, lookupType ?? "teaching", topicKey === "negative-verb-form")
        : buildTopicIndexContext(topicEntry, lookupType ?? "teaching");
      const systemPrompt = buildSystemPrompt(intent, mode, difficulty, language, lookupType);
      const prompt       = `${systemPrompt}\n\nContext:\n${context}\n\nQuestion: ${question}`;

      console.log(`\nTopic index hit: "${topicKey}" (${topicEntry.summary.totalMatches} matches, lessons [${topicEntry.summary.lessonNumbers.join(", ")}])`);
      if (debugLookupEarly) console.log(`\n${"═".repeat(60)}\n`);

      console.log("\nAsking model...\n");
      const answer = await llm.chat([{ role: "user", content: prompt }]);
      console.log("Answer:\n");
      console.log(cleanOutput(answer));
      appendChatLog({
        timestamp: new Date().toISOString(),
        question,
        answer: cleanOutput(answer),
        mode,
        intent,
        model: llmConfig.model,
        provider: llmConfig.provider,
        ...(topicKey ? { topicIndexKey: topicKey } : {}),
        retrievedChunks: topicEntry.matches.slice(0, 10).map((m) => ({
          id: m.chunkId,
          sourceType: m.sourceType,
        })),
        durationMs: Date.now() - interactionStart,
        ...(isFollowUp ? { isFollowUp: true } : {}),
        ...(isFollowUp && previousLogEntry ? { previousTurnId: previousLogEntry.timestamp } : {}),
      });
      return;
    }

    // No topic index hit — redirect to CourseIndex if question has curriculum intent
    if (detectCurriculumIntent(question)) {
      useCurriculumPath = true;
      if (debugLookupEarly) {
        console.log(`  → No topic index hit; curriculum intent detected — redirecting to CourseIndex`);
        console.log(`\n${"═".repeat(60)}\n`);
      }
    } else {
      if (debugLookupEarly) {
        console.log(`  → No topic index hit; falling through to semantic retrieval`);
        console.log(`\n${"═".repeat(60)}\n`);
      }
    }
  }

  // ── CourseIndex path (curriculum mode or lookup redirect) ────────────────
  // Deterministic alias-based retrieval over summary chunks; no embeddings needed.
  if (useCurriculumPath) {
    const curriculumQueryType = detectCurriculumQueryType(question);
    const curriculumAliases   = extractCurriculumAliases(question);
    const debugCurriculum     = process.env.COURSE_LOOKUP_DEBUG === "true";

    console.log(`\nIntent: curriculum  |  Query type: ${curriculumQueryType}  |  Language: ${language}`);
    console.log(`CourseIndex: ${courseIndex.lessonCount} lessons indexed`);
    if (lessonNumber !== null) console.log(`Target lesson: ${lessonNumber}`);

    const ciResult = courseIndex.select(curriculumQueryType, curriculumAliases, lessonNumber);

    if (debugCurriculum) {
      console.log(`\n  Aliases extracted: ${curriculumAliases.join(", ") || "(none)"}`);
      if (ciResult) {
        console.log(`  Matched aliases  : ${ciResult.matchedAliases.join(", ") || "(none)"}`);
        console.log(`  Matched lessons  : ${ciResult.matchedLessons.join(", ")}`);
        console.log(`  Chunks selected  : ${ciResult.chunks.length}`);
        for (const chunk of ciResult.chunks) {
          const ln = chunk.lessonNumber !== null ? `lesson=${chunk.lessonNumber}` : "lesson=?";
          console.log(`    ${ln.padEnd(10)}  ${chunk.id}`);
        }
      } else {
        console.log(`  → No CourseIndex matches`);
      }
      console.log(`\n${"═".repeat(60)}\n`);
    } else {
      if (ciResult) {
        console.log(`Matched lessons: [${ciResult.matchedLessons.join(", ")}]  chunks: ${ciResult.chunks.length}`);
      }
    }

    if (ciResult) {
      const context      = buildCurriculumContext(ciResult, curriculumQueryType);
      const systemPrompt = buildSystemPrompt(intent, "curriculum", difficulty, language);
      const prompt       = `${systemPrompt}\n\nContext:\n${context}\n\nQuestion: ${question}`;

      console.log("\nAsking model...\n");
      const answer = await llm.chat([{ role: "user", content: prompt }]);
      console.log("Answer:\n");
      console.log(cleanOutput(answer));
      appendChatLog({
        timestamp: new Date().toISOString(),
        question,
        answer: cleanOutput(answer),
        mode: "curriculum",
        intent,
        model: llmConfig.model,
        provider: llmConfig.provider,
        retrievedChunks: ciResult.chunks.slice(0, 10).map((c) => ({
          id: c.id,
          sourceType: c.sourceType,
        })),
        durationMs: Date.now() - interactionStart,
        ...(isFollowUp ? { isFollowUp: true } : {}),
        ...(isFollowUp && previousLogEntry ? { previousTurnId: previousLogEntry.timestamp } : {}),
      });
      return;
    }

    console.log("CourseIndex: no matches; falling through to semantic retrieval.");
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
      // curriculum mode reaching here means CourseIndex had no match — use explanation mix
      const mix = MIX[mode === "curriculum" ? "explanation" : mode];
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
  appendChatLog({
    timestamp: new Date().toISOString(),
    question,
    answer: cleanOutput(answer),
    mode,
    intent,
    model: llmConfig.model,
    provider: llmConfig.provider,
    retrievedChunks: selected.slice(0, 10).map((s) => ({
      id: s.chunk.id,
      sourceType: s.chunk.sourceType,
      score: s.rawScore,
    })),
    durationMs: Date.now() - interactionStart,
    ...(isFollowUp ? { isFollowUp: true } : {}),
    ...(isFollowUp && previousLogEntry ? { previousTurnId: previousLogEntry.timestamp } : {}),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
