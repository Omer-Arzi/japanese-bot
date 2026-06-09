import * as fs from "fs";
import * as path from "path";

const PROJECT_DIR = path.join(__dirname, "..", "..");
const IS_SMOKE = process.argv.includes("--smoke");
const ANSWERS_PATH = path.join(PROJECT_DIR, "evals", "runs", "latest", IS_SMOKE ? "smoke_answers.json" : "answers.json");
const REPORT_PATH = path.join(PROJECT_DIR, "evals", "runs", "latest", IS_SMOKE ? "smoke_critic_report.md" : "critic_report.md");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreviousTurn {
  question: string;
  answer: string;
}

export interface EvalResult {
  id: string;
  topic: string;
  question: string;
  answer: string;
  retrievedChunks: unknown[];
  timestamp: string;
  durationMs: number;
  error?: string;
  type?: "standalone" | "followup";
  dependsOn?: string;
  expectedBehavior?: string[];
  previousTurn?: PreviousTurn;
}

interface Finding {
  check: string;
  passed: boolean;
  excerpt?: string | undefined;
  detail?: string | undefined;
  likelyCause?: string | undefined;
  suggestedFix?: string | undefined;
}

export interface QuestionReport {
  id: string;
  topic: string;
  question: string;
  // "SKIP" = followup question whose previous context was unavailable
  status: "PASS" | "FAIL" | "SKIP";
  findings: Finding[];
  error?: string;
}

// ─── Excerpt helper ───────────────────────────────────────────────────────────

// Returns the sentence/line containing the first match, trimmed to ~120 chars.
function excerpt(answer: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(answer);
  if (!match) return undefined;
  const idx = match.index;
  // Find surrounding sentence boundary
  const start = Math.max(0, answer.lastIndexOf("\n", idx - 1) + 1);
  const end = Math.min(answer.length, answer.indexOf("\n", idx + match[0].length));
  const line = answer.slice(start, end === -1 ? undefined : end).trim();
  if (line.length <= 120) return `\`${line}\``;
  const center = idx - start;
  const lo = Math.max(0, center - 55);
  return `\`...${line.slice(lo, lo + 115)}...\``;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function checkEmptyParens(answer: string): Finding {
  const re = /\(\s*\)/g;
  const matches = answer.match(re) ?? [];
  return {
    check: "empty-parentheses",
    passed: matches.length === 0,
    excerpt: excerpt(answer, re),
    detail: matches.length > 0 ? `Found ${matches.length} empty parentheses` : undefined,
    likelyCause: "Formatting artifacts leaking from noisy PDF context",
    suggestedFix:
      "Verify cleanOutput() empty-parens regex covers this case; also check if the source chunk contains ().",
  };
}

function checkWeirdNumbering(answer: string): Finding {
  const re = /^-?\s*0\d\s*$/m;
  const match = re.exec(answer);
  return {
    check: "weird-numbering",
    passed: !match,
    excerpt: match ? `\`${match[0].trim()}\`` : undefined,
    detail: match ? `Suspicious line: "${match[0].trim()}"` : undefined,
    likelyCause: "Zero-prefixed page numbers from PDF extraction leaking through context",
    suggestedFix:
      "Extend isPageArtifact() in cleanOutput() to catch /^-?\\s*0\\d\\s*$/ lines.",
  };
}

function checkHebrewRepetition(answer: string): Finding {
  const STOPWORDS = new Set(["של", "את", "הוא", "היא", "כי", "אבל", "הם", "לא", "עם", "על", "זה", "הם"]);
  const words = answer.match(/[א-ת]{2,}/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const repeated = [...freq.entries()]
    .filter(([w, n]) => n >= 4 && !STOPWORDS.has(w))
    .sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `"${w}" ×${n}`);
  return {
    check: "hebrew-repetition",
    passed: repeated.length === 0,
    detail: repeated.length > 0 ? `Over-repeated words: ${repeated.join(", ")}` : undefined,
    likelyCause: "Model re-states the same explanation phrase multiple times in a single answer",
    suggestedFix:
      "Strengthen 'each idea appears once' rule in HEBREW_BASE_RULES; the dedup filter in cleanOutput() only catches identical lines.",
  };
}

function checkOverconfidentPhrases(answer: string): Finding {
  const PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /\ball\s+(verbs?|adjectives?|nouns?|words?|particles?)\b/i, label: '"all [grammar item]"' },
    { re: /\bwithout\s+exception\b/i, label: '"without exception"' },
    // "always use な/きれい/[Japanese form]" is accurate grammar instruction — exclude it.
    // Also exclude "always use **..." (bold markdown before a specific form).
    { re: /\balways\s+(?!use\s+(?:な|\*{0,2}[ぁ-ん々〆〤ァ-ヶ一-龥]))(use|mark|means?|indicates?)\b/i, label: '"always [verb]"' },
    { re: /\bthe\s+rule\s+is\s+that\b/i, label: '"the rule is that"' },
    { re: /\bevery\s+(verb|adjective|noun|particle)\b/i, label: '"every [grammar item]"' },
    { re: /\bכל\s+הפעלים\b/, label: '"כל הפעלים" (all verbs in Hebrew)' },
    { re: /\bתמיד\s+מסמן\b/, label: '"תמיד מסמן" (always marks in Hebrew)' },
  ];
  const hits = PATTERNS.filter(({ re }) => re.test(answer));
  const firstHit = hits[0];
  return {
    check: "overconfident-phrasing",
    passed: hits.length === 0,
    excerpt: firstHit ? excerpt(answer, firstHit.re) : undefined,
    detail: hits.length > 0 ? `Phrases: ${hits.map((h) => h.label).join(", ")}` : undefined,
    likelyCause: "Model presents a partial rule or exception as a universal statement",
    suggestedFix:
      'Add the offending phrase to the overconfident-phrasing list in critic.ts AND add a counter-example to TEACHING_STYLE: say "in most cases" or "generally" for this topic.',
  };
}

function checkRomajiPresence(question: string, answer: string): Finding {
  const questionWantsExample = /\b(example|romaji|give an example|show|demonstrate)\b/i.test(question);
  if (!questionWantsExample) return { check: "romaji-in-example", passed: true };
  const hasRomaji = /\b[a-z]{3,}\b/.test(answer);
  return {
    check: "romaji-in-example",
    passed: hasRomaji,
    detail: !hasRomaji ? "Question asked for an example but answer contains no romaji" : undefined,
    likelyCause: "Model answered conceptually without providing the requested romaji example",
    suggestedFix:
      'Add "always include a romaji example when the question says \'Give an example\'" to the explanation system prompt.',
  };
}

// Known incorrect romaji for common te-forms.
// Key = wrong form that might appear, value = correct form.
const WRONG_TE_FORMS: Record<string, string> = {
  kakete: "kaite (書いて)",
  akete: "aite (開いて) — check context",
  kikete: "kiite (聞いて)",
  kakite: "kaite (書いて)",
  ikite: "itte (いって) — iku is irregular",
};

function checkKnownVerbErrors(answer: string): Finding {
  const hits: Array<{ wrong: string; correct: string; ex: string | undefined }> = [];
  for (const [wrong, correct] of Object.entries(WRONG_TE_FORMS)) {
    const re = new RegExp(`\\b${wrong}\\b`, "i");
    if (re.test(answer)) {
      hits.push({ wrong, correct, ex: excerpt(answer, re) });
    }
  }
  const first = hits[0];
  return {
    check: "known-verb-error",
    passed: hits.length === 0,
    excerpt: first?.ex,
    detail: hits.length > 0
      ? hits.map((h) => `"${h.wrong}" should be "${h.correct}"`).join("; ")
      : undefined,
    likelyCause:
      "Model applied the standard te-form conjugation rule to an irregular or misremembered verb",
    suggestedFix:
      "Add the specific wrong+correct pair to GRAMMAR_ACCURACY_RULES under 'Known exceptions'. Example: かく → かいて (NOT kakete).",
  };
}

// Semantically unnatural noun+verb combinations.
const SEMANTIC_VIOLATIONS: Array<{ re: RegExp; description: string }> = [
  {
    re: /\bhon\b.{0,30}\b(nomu|nomimasu|nomimasen|nonde|drink)\b/i,
    description: "hon (book) used with nomu/drink — books cannot be drunk",
  },
  {
    re: /\b(nomu|nomimasu|nomimasen|nonde|drink)\b.{0,30}\bhon\b/i,
    description: "drink verb paired with hon (book) — semantically impossible",
  },
  {
    re: /\btsukue\b.{0,30}\b(taberu|tabemasu|tabemasita|eat)\b/i,
    description: "tsukue (desk) used with taberu/eat — desks cannot be eaten",
  },
  {
    re: /\bhon\b.{0,15}(wa|ga|wo).{0,15}\boishii\b/i,
    description: "hon (book) described as oishii (delicious) — books are not food",
  },
  {
    re: /\bkono hon wa oishii\b/i,
    description: '"kono hon wa oishii desu" — the classic bad example from the guidelines',
  },
];

function checkSemanticNaturalness(answer: string): Finding {
  const hits = SEMANTIC_VIOLATIONS.filter(({ re }) => re.test(answer));
  const first = hits[0];
  return {
    check: "semantic-mismatch",
    passed: hits.length === 0,
    excerpt: first ? excerpt(answer, first.re) : undefined,
    detail: hits.length > 0 ? hits.map((h) => h.description).join("; ") : undefined,
    likelyCause:
      "Model generated a grammatically valid sentence without checking whether the noun+verb or noun+adjective combination makes real-world sense",
    suggestedFix:
      'Add the specific bad example to the "semantically unnatural" list in GRAMMAR_ACCURACY_RULES. e.g.: "hon to koohii wo nomimasu" is invalid — use "koohii to ocha wo nomimasu" instead.',
  };
}

// Detect when と is used where を is needed (direct object marker).
// Pattern: "X to verb" where X is a single drinkable/eatable item (not a list with と connecting two items).
function checkParticleConfusion(answer: string): Finding {
  // Specific known bad patterns from actual answers
  const BAD_PATTERNS: Array<{ re: RegExp; description: string }> = [
    {
      re: /\bko-?h[iī]{1,2}\s+to\s+nomi/i,
      description: '"koohii to nomimasu/masen" — を should mark the direct object, not と (と connects lists, not objects)',
    },
    {
      re: /\bmizu\s+to\s+nom/i,
      description: '"mizu to nomu" — を should be used here, not と',
    },
  ];
  const hits = BAD_PATTERNS.filter(({ re }) => re.test(answer));
  const first = hits[0];
  return {
    check: "particle-confusion",
    passed: hits.length === 0,
    excerpt: first ? excerpt(answer, first.re) : undefined,
    detail: hits.length > 0 ? hits.map((h) => h.description).join("; ") : undefined,
    likelyCause:
      "Model used と (list connector) in place of を (object marker) when there is only one object",
    suggestedFix:
      'Add this specific bad sentence to GRAMMAR_ACCURACY_RULES under を rules: "koohii to nomimasen" is wrong — use "koohii wo nomimasen".',
  };
}

// ─── Romaji / language accuracy checks ───────────────────────────────────────

// Detect a stray CJK character embedded inside otherwise Latin prose.
// Pattern: Latin word — space — single CJK char — space — Latin word.
// This catches "For 的 example" but not "書きます (kakimasu)" lines.
function checkMixedLanguageGarbage(answer: string): Finding {
  // Only flag CJK unified ideographs (U+4E00-U+9FFF, U+3400-U+4DBF) — not hiragana/katakana,
  // which appear intentionally in Japanese teaching content (e.g. "while が marks...").
  const re = /\b[a-zA-Z]{2,}\s+[一-鿿㐀-䶿]\s+[a-zA-Z]{2,}\b/;
  const match = re.exec(answer);
  return {
    check: "mixed-language-garbage",
    passed: !match,
    excerpt: match ? excerpt(answer, re) : undefined,
    detail: match ? `Stray CJK character inside Latin prose: "${match[0]}"` : undefined,
    likelyCause:
      "Model copy-pasted a fragment from a Japanese/Chinese context into an English sentence, likely via noisy retrieved context",
    suggestedFix:
      "Add a cleanup pass to strip isolated CJK characters surrounded by Latin words in cleanOutput(). Also audit retrieved chunks for mixed-script noise.",
  };
}

// Known wrong romanization pairs observed in eval runs.
// Each entry is triggered only when the Japanese form appears in the answer,
// and fails when the wrong romaji appears nearby.
interface RomajiMistake {
  id: string;
  japanese: RegExp;           // must be present to trigger the check
  wrongRomaji: RegExp;        // the incorrect romanization pattern
  description: string;
  correct: string;
}

const ROMAJI_MISTAKES: RomajiMistake[] = [
  {
    id: "hana-hanami",
    japanese: /花/,
    wrongRomaji: /\bhanami\b/i,
    description: '花 romanized as "hanami" — hanami (花見) means flower-viewing, not "flower"',
    correct: "hana (花 = flower)",
  },
  {
    id: "kaite-kite",
    japanese: /書いて/,
    wrongRomaji: /書いて\s*\([^)]*\bkite\b|(?<!\bi)kite(?!\s*[iī]masu)\b.{0,30}書いて|書いて.{0,30}\bkite\b/i,
    description: '書いて romanized as "kite" — きて (kite) means "come", not "write (te-form)"',
    correct: "kaite (書いて = te-form of kaku, to write)",
  },
  {
    id: "kaite-imasu-kite-imasu",
    japanese: /書いています/,
    wrongRomaji: /書いています\s*\([^)]*\bkite\s+imasu\b|書いています.{0,30}\bkite\s+imasu\b|\bkite\s+imasu\b.{0,30}書いています/i,
    description: '書いています romanized as "kite imasu" — kite imasu (きています) means "has come/is here", not "is writing"',
    correct: "kaite imasu (書いています = progressive form of kaku, to write)",
  },
  {
    id: "kakimasu-kimasu",
    japanese: /書きます/,
    wrongRomaji: /書きます\s*\([^)]*\bkimasu\b|\bkimasu\b.{0,30}書きます|書きます.{0,30}\bkimasu\b/i,
    description: '書きます romanized as "kimasu" — kimasu (きます) means "come", not "write (polite)"',
    correct: "kakimasu (書きます = polite form of kaku, to write)",
  },
  {
    id: "kirei-daikirai",
    japanese: /きれいではありません/,
    wrongRomaji: /daikirai/i,
    description:
      'きれいではありません romanized as "daikirai" — daikirai (大嫌い) means "really dislike", an entirely different word',
    correct: 'kirei dewa arimasen (きれいではありません = "is not beautiful/clean")',
  },
  {
    id: "ikimasu-iku-masu",
    japanese: /行きます/,
    wrongRomaji: /\biku\s+masu\b/i,
    description:
      '行きます romanized as "iku masu" (two words) — the polite conjugated form is one word',
    correct: "ikimasu (行きます = polite present of iku)",
  },
  {
    id: "hon-kakimasu-kimasu",
    japanese: /本を書きます/,
    wrongRomaji: /hon\s+[ow]?\s*kimasu/i,
    description:
      '本を書きます romanized as "hon o kimasu" — kimasu (きます) means "come", not "write"',
    correct: "hon o kakimasu (本を書きます = I write a book)",
  },
];

function checkRomajiAccuracy(answer: string): Finding {
  const hits = ROMAJI_MISTAKES.filter(
    ({ japanese, wrongRomaji }) => japanese.test(answer) && wrongRomaji.test(answer),
  );
  const first = hits[0];
  const firstRe = first?.wrongRomaji;

  return {
    check: "romaji-accuracy",
    passed: hits.length === 0,
    excerpt: first && firstRe ? excerpt(answer, firstRe) : undefined,
    detail: hits.length > 0
      ? hits.map((h) => `[${h.id}] ${h.description}`).join(" | ")
      : undefined,
    likelyCause:
      "Model romanized a kanji using the wrong reading, often confusing homophone kana forms or misremembering the verb stem",
    suggestedFix: hits.length > 0
      ? hits.map((h) => `Correct "${h.id}": use ${h.correct}`).join(" | ")
      : undefined,
  };
}

// ─── Japanese knowledge checks (context-gated) ───────────────────────────────

// Only runs when the question or answer mentions きれい / kirei.
// FAIL: answer classifies kirei as an i-adjective.
// PASS: answer identifies it as a na-adjective (or topic is not relevant).
function checkKireiClassification(question: string, answer: string): Finding {
  const SKIP: Finding = { check: "kirei-classification", passed: true };
  const combined = question + " " + answer;
  if (!/kirei|きれい/i.test(combined)) return SKIP;

  // Wrong: kirei directly described as i-adjective (positive attribution, not negation).
  // Requires "is/are" immediately before the article + "i-adjective" within 40 chars of "kirei",
  // so "kirei is a na-adjective, not an i-adjective" and "like kirei ... are NOT i-adjectives" both pass.
  const wrongRe = /\bkirei\b[^.!?\n]{0,40}?\b(?:is|are)\s+(?:an?\s+)?i[-\s]adjective/i;
  // Also wrong: says "i-adjective" without mentioning "na-adjective" at all in the same answer
  const saysI   = /\bi[-\s]adjective\b/i.test(answer);
  const saysNa  = /\bna[-\s]adjective\b/i.test(answer);
  const hasWrongExplicit = wrongRe.test(answer);

  // If the answer mentions kirei and says "i-adjective" without ever saying "na-adjective", that's a fail
  const failed = hasWrongExplicit || (saysI && !saysNa);

  return {
    check: "kirei-classification",
    passed: !failed,
    excerpt: failed ? (excerpt(answer, wrongRe) ?? excerpt(answer, /\bi[-\s]adjective\b/i)) : undefined,
    detail: failed
      ? hasWrongExplicit
        ? 'Answer explicitly calls きれい an i-adjective'
        : 'Answer mentions "i-adjective" without ever identifying きれい as a na-adjective'
      : undefined,
    likelyCause:
      'Model overgeneralizes the "ends in い → i-adjective" surface rule without checking the actual word type',
    suggestedFix:
      'In GRAMMAR_ACCURACY_RULES add: "きれい (kirei) ends in い but is a na-adjective. The final い is part of the word root, not the i-adjective suffix. Wrong: きれいくない. Correct: きれいじゃない."',
  };
}

// Only runs when the question or answer mentions 好き / suki.
// FAIL: answer says が marks the "direct object" in a suki sentence.
// PASS: answer correctly explains が marks the thing liked (not a direct object).
function checkSukiParticle(question: string, answer: string): Finding {
  const SKIP: Finding = { check: "suki-particle", passed: true };
  const combined = question + " " + answer;
  if (!/suki|好き/.test(combined)) return SKIP;

  // Bad: anywhere near suki discussion, が is called "direct object"
  const badPatterns: RegExp[] = [
    /ga\b.{0,60}(direct\s+object|marks\s+the\s+object)/i,
    /が.{0,60}(直接目的語|מושא\s+ישיר)/,
    /が.{0,60}direct\s+object/i,
    /(direct\s+object).{0,60}\bga\b/i,
  ];

  const hit = badPatterns.find((re) => re.test(answer));
  return {
    check: "suki-particle",
    passed: !hit,
    excerpt: hit ? excerpt(answer, hit) : undefined,
    detail: hit ? 'Answer describes が as a "direct object" marker in the context of 好き' : undefined,
    likelyCause:
      'Model treats が after suki like を after a transitive verb, confusing the grammatical role',
    suggestedFix:
      'In GRAMMAR_ACCURACY_RULES clarify: "With 好き/suki, が marks the thing that is liked — not a direct object. 好き is adjectival; the thing liked is its subject/topic, not its object. Example: 猫が好きです (neko ga suki desu) — cats are liked [by me]."',
  };
}

// Only runs when the question or answer discusses the と+を list pattern.
// FAIL: answer says を marks "only the first" or "the first" object in a list.
// PASS: answer correctly says を marks the entire list as the direct object.
function checkToVsWo(question: string, answer: string): Finding {
  const SKIP: Finding = { check: "to-vs-wo", passed: true };
  const combined = question + " " + answer;
  // Only relevant when both と and を are mentioned together
  if (!(/(to|と)/.test(combined) && /(wo|を)/.test(combined))) return SKIP;

  const badPatterns: RegExp[] = [
    /wo\b.{0,50}\b(only|just)\b.{0,30}\b(first|noun|object)\b/i,
    /marks\s+(only\s+)?the\s+first\s+(object|noun)/i,
    /を\s*[はがもの]?\s*(最初|first).{0,20}(object|目的語)/i,
    /を.{0,40}最初の.{0,20}(名詞|目的)/,
  ];

  const hit = badPatterns.find((re) => re.test(answer));
  return {
    check: "to-vs-wo",
    passed: !hit,
    excerpt: hit ? excerpt(answer, hit) : undefined,
    detail: hit ? 'Answer says を marks only the first object in a と-linked list' : undefined,
    likelyCause:
      'Model treats と as a co-marker and assigns を only to the immediately preceding noun, rather than understanding を scopes over the whole と-phrase',
    suggestedFix:
      'In GRAMMAR_ACCURACY_RULES under を: add "When nouns are joined by と before を, を marks the ENTIRE list as one direct object — not just the first noun. ラーメンとぎょうざを食べます: を marks ラーメンとぎょうざ as a single object unit."',
  };
}

// FAIL if the same Hebrew sentence (5+ chars, ending with punctuation or line break)
// appears more than once in the answer.
function checkHebrewDuplicateSentences(answer: string): Finding {
  // Extract Hebrew sentences: runs of Hebrew text ending in punctuation or newline
  const sentenceRe = /[א-ת][א-ת\s,\-–—״׳]{4,}[.!?:]/g;
  const sentences = answer.match(sentenceRe) ?? [];
  const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

  const seen = new Map<string, number>();
  for (const s of sentences) {
    const key = normalise(s);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s);

  return {
    check: "hebrew-duplicate-sentence",
    passed: dupes.length === 0,
    excerpt: dupes[0] ? `\`${dupes[0].slice(0, 100)}\`` : undefined,
    detail: dupes.length > 0
      ? `${dupes.length} Hebrew sentence(s) appear more than once`
      : undefined,
    likelyCause:
      "Model repeats the same full explanation sentence, often when summarising after already stating the same point",
    suggestedFix:
      'Strengthen the "every idea appears once only" rule in HEBREW_BASE_RULES and TEACHING_STYLE_HE. Consider adding a post-processing dedup pass in cleanOutput() for full sentences.',
  };
}

// ─── Placeholder text check ───────────────────────────────────────────────────

// FAIL if the answer contains bracket-placeholder text that should have been
// replaced by real content — e.g. LLM echoing a format example from the prompt.
function checkPlaceholderText(answer: string): Finding {
  const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /\[short\s+quote(?:\s+from\s+(?:the\s+)?(?:text|context|excerpt))?\]/i, label: '"[short quote...]"' },
    { re: /\[quote\s+here\]/i,   label: '"[quote here]"' },
    { re: /\[excerpt\]/i,        label: '"[excerpt]"' },
    { re: /\[TODO\]/i,           label: '"[TODO]"' },
    { re: /\[ציטוט\s+קצר\]/,    label: '"[ציטוט קצר]"' },
    { re: /\[your\s+(?:quote|excerpt|text)\]/i, label: '"[your quote/excerpt/text]"' },
    // Generic bracket placeholder: [word word] where inner text looks like a substitution hint
    { re: /\[(?:insert|add|put|place|copy)\s+[^\]]{3,40}\]/i, label: '"[insert/add/copy ...]"' },
  ];

  const hit = PLACEHOLDER_PATTERNS.find(({ re }) => re.test(answer));
  return {
    check: "placeholder-text",
    passed: !hit,
    excerpt: hit ? excerpt(answer, hit.re) : undefined,
    detail: hit ? `Answer contains placeholder text ${hit.label}` : undefined,
    likelyCause:
      "System prompt uses bracket placeholders as format examples; the model echoed them instead of substituting real content",
    suggestedFix:
      'Replace bracket placeholders in buildSystemPrompt() answer-format section with prose instructions: "copy a short phrase directly from the retrieved text, or omit if nothing fits".',
  };
}

// ─── Lookup answer quality ────────────────────────────────────────────────────

// Appearance-lookup signals: question asks where a topic appears in materials,
// not which lesson formally taught it. These questions may validly answer without
// a lesson number — workbook/exercise appearances are acceptable evidence.
const APPEARANCE_QUESTION_PATTERNS: RegExp[] = [
  /\bwhere\s+does\s+.{0,60}\bappear\b/i,
  /\bwhere\s+(is|are)\s+.{0,60}\b(mentioned|used|found|referenced)\b/i,
  /\bin\s+(the\s+)?workbook\b/i,
  /\bin\s+(the\s+)?exercises?\b/i,
  /\bwhere\s+.{0,30}\bappears?\b/i,
  // Yes/no coverage questions — a content-bearing yes/no answer is sufficient; no lesson number needed.
  /\bdo\s+(?:my|your|the|our)\s+materials?\b/i,
  /\bdid\s+we\s+(?:already\s+)?(?:cover|learn|study|go\s+over)\b/i,
  /\bis\s+.{0,60}\bexplained\s+somewhere\b/i,
  /\bdoes\s+(?:my|your|the|our)\s+(?:course|material|workbook|textbook)\b/i,
];

// Signals that a lookup answer has concrete material evidence.
// Accepted for appearance lookups even when no lesson number is present.
const MATERIAL_EVIDENCE_PATTERNS: RegExp[] = [
  /\bworkbook\b/i,
  /\bexercise[s]?\b/i,
  /\bchunk\b/i,
  /\bsource(?:Type|File)?\b/i,
  /\bincidental\b/i,
  /\bgrammar[\s-]reference\b/i,
  /\bexcerpt\b/i,
  /\bsection\b/i,
  /\bappears?\s+in\b/i,
  /\bfound\s+in\b/i,
  /\bmentioned\s+in\b/i,
  /\b(?:your|my|the|our)\s+materials?\b/i,
  /\b(?:your|my|the|our)\s+(?:course|workbook|textbook|notes)\b/i,
];

// Only runs for questions with topic starting "lookup-".
// Two sub-rules depending on question type:
//
//   A. Lesson-location lookup ("which lesson", "lesson number", "where did we learn"):
//      FAIL if answer has neither a lesson number nor the fallback sentence.
//
//   B. Appearance lookup ("where does X appear", "in the workbook"):
//      PASS if answer has a lesson number, fallback, OR concrete material evidence.
//      (Workbook appearances legitimately have no lesson number.)
function checkLookupAnswerQuality(topic: string, question: string, answer: string): Finding {
  const SKIP: Finding = { check: "lookup-answer-quality", passed: true };
  if (!topic.startsWith("lookup-")) return SKIP;

  // General knowledge phrases that must never appear in a lookup answer
  const GENERAL_PHRASES: Array<{ re: RegExp; label: string }> = [
    { re: /\btypically\b/i,                      label: '"typically"' },
    { re: /\busually\b/i,                         label: '"usually"' },
    { re: /\bin\s+most\s+beginner\s+courses?\b/i, label: '"in most beginner courses"' },
    { re: /\bin\s+general\b/i,                    label: '"in general"' },
    { re: /\bgenerally\s+speaking\b/i,            label: '"generally speaking"' },
    { re: /\bin\s+standard\s+japanese\b/i,        label: '"in standard Japanese"' },
  ];

  const hit = GENERAL_PHRASES.find(({ re }) => re.test(answer));
  if (hit) {
    return {
      check: "lookup-answer-quality",
      passed: false,
      excerpt: excerpt(answer, hit.re),
      detail: `Answer uses general knowledge phrase ${hit.label} in a lookup-intent response`,
      likelyCause:
        "Lookup intent was not detected, so the normal grammar prompt was used — which allows general knowledge",
      suggestedFix:
        "Check that LOOKUP_PATTERNS in ask.ts matches the question. Verify Mode: lookup appears in diagnostics output.",
    };
  }

  const hasLessonNumber   = /\blesson\s+\d+\b/i.test(answer);
  const hasFallback       = /couldn['']t\s+(?:find|map|locate|identify)|could\s+not\s+(?:find|map|locate|identify)|לא\s+מצאתי/i.test(answer);
  const isAppearanceQuery = APPEARANCE_QUESTION_PATTERNS.some((re) => re.test(question));
  const hasMaterialEvidence = MATERIAL_EVIDENCE_PATTERNS.some((re) => re.test(answer));

  if (isAppearanceQuery) {
    // For appearance queries, lesson number OR material evidence OR fallback is acceptable.
    if (!hasLessonNumber && !hasMaterialEvidence && !hasFallback) {
      return {
        check: "lookup-answer-quality",
        passed: false,
        excerpt: excerpt(answer, /^.{0,120}/m),
        detail:
          "Appearance-lookup answer contains no lesson number, no material evidence (workbook/chunk/excerpt/section), and no fallback sentence",
        likelyCause:
          "Model gave a general grammar explanation instead of reporting where the topic appears in the indexed materials",
        suggestedFix:
          'Check that LOOKUP_PATTERNS and APPEARANCE_PATTERNS in ask.ts match this question. The answer should reference source materials (workbook, excerpt, section) not explain the grammar topic.',
      };
    }
    return SKIP;
  }

  // Lesson-location query: must have a lesson number or the fallback sentence.
  if (!hasLessonNumber && !hasFallback) {
    return {
      check: "lookup-answer-quality",
      passed: false,
      excerpt: excerpt(answer, /^.{0,120}/m),
      detail:
        "Lesson-location lookup answer contains neither a lesson number nor the fallback sentence",
      likelyCause:
        'Model ignored lookup mode and gave a general grammar explanation. Check that "Mode: lookup" appears in ask-sensei diagnostics.',
      suggestedFix:
        'Re-run with the exact question and check stdout for "Mode: lookup | Retrieval-only: YES". If it shows a different mode, add the missing phrase to LOOKUP_PATTERNS in ask.ts.',
    };
  }

  return SKIP;
}

// Only runs for lookup-topic questions that are "materials-coverage" style
// (e.g. "Do my materials explain X?", "Is X in my course?").
// Fails if the answer gives a standalone grammar explanation without a real
// material/lesson citation — i.e. the model escaped retrieval-only mode.
const MATERIALS_COVERAGE_PATTERNS: RegExp[] = [
  /\bdo\s+(?:my|your|the|our)\s+materials?\s+(?:explain|cover|contain|include|mention)\b/i,
  /\bdoes\s+(?:my|your|the|our)\s+(?:course|workbook|textbook|material)\s+(?:explain|cover|contain|include|mention)\b/i,
  /\bdo\s+(?:my|your|the|our)\s+(?:course\s+)?materials?\b/i,
];

// Signals a real source citation (stricter than MATERIAL_EVIDENCE_PATTERNS —
// "your materials" alone is just a question paraphrase, not a citation).
const SOURCE_CITATION_PATTERNS: RegExp[] = [
  /\blesson\s+\d+\b/i,
  /\bin\s+(the\s+)?workbook\b/i,
  /\bin\s+(the\s+)?exercises?\b/i,
  /\bfound\s+in\b/i,
  /\bappears?\s+in\b/i,
  /\bmentioned\s+in\b/i,
  /\bsection\b/i,
  /\bexcerpt\b/i,
  /\bgrammar[\s-]reference\b/i,
];

// Signals that an answer is giving a grammar lesson rather than citing sources.
// Patterns are written to match through markdown bold/italic markers (**text**).
const GRAMMAR_TEACHING_PATTERNS: RegExp[] = [
  /\bmarks?\s+the\s+\*{0,2}(topic|subject|object|direct\s+object)\b/i,
  /\bis\s+used\s+to\s+mark\b/i,
  /\bindicates?\s+the\s+\*{0,2}(topic|subject|direct\s+object)\b/i,
  /\b(は|が|を|に|で|と)\s+\*{0,2}marks?\b/i,
  /\bpronounced\s+"(wa|ga|wo|ni|de|to)"\s+when\s+used\s+as\s+a\s+particle\b/i,
  /\bhere'?s?\s+the\s+correct\s+explanation\b/i,
];

function checkLookupTeachingEscape(topic: string, question: string, answer: string): Finding {
  const SKIP: Finding = { check: "lookup-teaching-escape", passed: true };

  if (!topic.startsWith("lookup-")) return SKIP;

  const isCoverageQuestion = MATERIALS_COVERAGE_PATTERNS.some((re) => re.test(question));
  if (!isCoverageQuestion) return SKIP;

  const hasSourceCitation  = SOURCE_CITATION_PATTERNS.some((re) => re.test(answer));
  const hasFallback        = /couldn['']t\s+(?:find|map|locate|identify)|could\s+not\s+(?:find|map|locate)|לא\s+מצאתי/i.test(answer);
  const hasTeachingEscape  = GRAMMAR_TEACHING_PATTERNS.some((re) => re.test(answer));

  // Teaching escape: answer explains grammar but cites no real material source.
  if (hasTeachingEscape && !hasSourceCitation && !hasFallback) {
    return {
      check: "lookup-teaching-escape",
      passed: false,
      excerpt: excerpt(answer, GRAMMAR_TEACHING_PATTERNS.find((re) => re.test(answer))!),
      detail:
        "Materials-coverage lookup answer gives a grammar explanation without citing any lesson or material source",
      likelyCause:
        'Model was not in lookup/retrieval-only mode. Check that "Mode: lookup | Retrieval-only: YES" appears in ask-sensei diagnostics.',
      suggestedFix:
        "Add the question pattern to LOOKUP_PATTERNS in src/ask.ts so the question routes to lookup mode.",
    };
  }

  return SKIP;
}

// ─── Negation type confusion check ───────────────────────────────────────────

// FAILs when a question asks specifically about verb negation but the answer presents
// adjective negation (くない) or suki negation (すきじゃない) as part of the answer
// without labeling them as a distinct negation type.
function checkNegationTypeConfusion(question: string, answer: string): Finding {
  const SKIP: Finding = { check: "negation-type-confusion", passed: true };

  // Only applies when the question is specifically about verb negation
  const asksVerbNegation =
    /\bnegative\s+verb\b|\bverb\s+negati(?:on|ve)\b|\bnegative\s+form\s+of\s+verb[s]?\b/i.test(question) ||
    /\bnegative\s+verb\s+form\b/i.test(question);
  if (!asksVerbNegation) return SKIP;

  // Check if the answer includes non-verb negation content
  const hasAdjNegation =
    /\bkunai\b|くない/i.test(answer) ||
    /i[- ]adjective.*negati|negati.*i[- ]adjective/i.test(answer);
  const hasSukiNegation =
    /suki\s*(?:ja\s*nai|janai|negative)|すき.*じゃない|negative\s+suki/i.test(answer);

  if (!hasAdjNegation && !hasSukiNegation) return SKIP;

  // Check whether the answer explicitly labels these as distinct from verb negation
  const hasDistinctionLabel =
    /(?:adjective\s+negat|suki\s+negat|related\s+but\s+distinct|distinct\s+from\s+verb|different\s+(?:type|form)\s+from|separate\s+from\s+verb|not\s+(?:a\s+)?verb\s+negat)/i.test(answer) ||
    /(?:also\s+covers?|note\s+that|however|by\s+contrast|unlike\s+verb)/i.test(answer);

  if (!hasDistinctionLabel) {
    const triggerRe = hasAdjNegation
      ? /\bkunai\b|くない|i[- ]adjective.*negati/i
      : /suki.*(?:ja\s*nai|janai)|すき.*じゃない/i;
    return {
      check: "negation-type-confusion",
      passed: false,
      excerpt: excerpt(answer, triggerRe),
      detail:
        "Answer includes adjective or suki negation in response to a verb-negation question without labeling them as distinct types",
      likelyCause:
        "The 'negative-form' topic index entry includes Lesson 10 (くない) and Lesson 11 (すきじゃない) alongside verb negation — the model presents all as 'negative verb form'",
      suggestedFix:
        "When answering verb-negation lookup questions, label adjective negation (くない) and suki negation (すきじゃない) as RELATED BUT DISTINCT from verb negation (ません)",
    };
  }

  return SKIP;
}

// ─── Follow-up checks ────────────────────────────────────────────────────────

// Checks that the answer references what the previous turn said (not a cold restart).
function checkFollowupContextReference(answer: string, previousTurn: PreviousTurn): Finding {
  const SKIP: Finding = { check: "followup-references-context", passed: true };

  // Extract lesson numbers mentioned in the previous answer
  const lessonRe = /lesson\s+(\d+)/gi;
  const prevLessons: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = lessonRe.exec(previousTurn.answer)) !== null) {
    prevLessons.push(m[1]!);
  }

  // Check for explicit back-reference phrases
  const backRefPhrases = [
    /\b(as|like)\s+(I|we)\s+(mentioned|said|noted|explained)\b/i,
    /\b(those|the)\s+(lessons?|chapters?|sections?)\b/i,
    /\bin\s+(my|the)\s+(previous|last|prior)\s+(answer|response|turn)\b/i,
    /\bthe\s+answer\s+above\b/i,
    /\bearlier\s+(I|we)\s+(mentioned|said|noted)\b/i,
  ];
  const hasBackRef = backRefPhrases.some((re) => re.test(answer));

  // Check that answer mentions at least one lesson number from the previous answer
  const answerMentionsPrevLesson =
    prevLessons.length > 0 &&
    prevLessons.some((ln) => new RegExp(`lesson\\s+${ln}\\b`, "i").test(answer));

  if (!hasBackRef && !answerMentionsPrevLesson) {
    return {
      check: "followup-references-context",
      passed: false,
      detail:
        "Follow-up answer does not reference the previous answer — reads like a standalone response",
      likelyCause:
        "The question was sent to ask-sensei without the previous turn context, or the model ignored it",
      suggestedFix:
        "Ensure the previous Q&A is injected into the prompt before the follow-up question",
    };
  }

  return SKIP;
}

// Checks that a 'why X?' follow-up explains the connection, not just describes X generically.
function checkFollowupNotGeneric(answer: string, question: string, previousTurn: PreviousTurn): Finding {
  const SKIP: Finding = { check: "followup-not-generic", passed: true };

  const isWhyQuestion = /^why\b/i.test(question.trim());
  if (!isWhyQuestion) return SKIP;

  // Detect generic lesson-description openers: "Lesson X covers/introduces/teaches/explains..."
  const genericRe = /lesson\s+\d+\s+(covers?|introduces?|teaches?|explains?|contains?|deals?\s+with|focuses?\s+on)/i;
  if (!genericRe.test(answer)) return SKIP;

  // Also require that the answer doesn't link back to the previous question
  const prevTopicWords = previousTurn.question
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const answerLower = answer.toLowerCase();
  const connectsBack = prevTopicWords.some((w) => answerLower.includes(w));

  if (!connectsBack) {
    return {
      check: "followup-not-generic",
      passed: false,
      excerpt: excerpt(answer, genericRe),
      detail:
        "Follow-up answer gives a generic lesson description without explaining why that lesson was mentioned in the previous answer",
      likelyCause:
        "The model treated the follow-up as a standalone question about the lesson rather than explaining the prior answer",
      suggestedFix:
        "Verify the previous turn context was injected into the prompt and that the system prompt instructs the model to explain its prior reasoning",
    };
  }

  return SKIP;
}

// Checks that the answer doesn't use uncertainty words when explaining a prior known answer.
function checkFollowupNoUncertainty(answer: string): Finding {
  const uncertaintyRe = /\b(likely|probably|might\s+be|perhaps|possibly|may\s+be|unclear|not\s+sure|uncertain)\b/i;
  const match = uncertaintyRe.exec(answer);
  return {
    check: "followup-no-uncertainty",
    passed: !match,
    excerpt: match ? excerpt(answer, uncertaintyRe) : undefined,
    detail: match
      ? `Uncertainty word "${match[0]}" found — a follow-up explaining a prior answer should be confident`
      : undefined,
    likelyCause:
      "Model is hallucinating or guessing about the previous answer rather than explaining what it actually said",
    suggestedFix:
      "Ensure the previous answer is included verbatim in the prompt so the model can refer to it directly",
  };
}

// ─── Per-question runner ──────────────────────────────────────────────────────

export function critiqueOne(result: EvalResult): QuestionReport {
  if (result.error) {
    return {
      id: result.id,
      topic: result.topic,
      question: result.question,
      status: "FAIL",
      findings: [],
      error: result.error,
    };
  }

  const findings: Finding[] = [
    checkEmptyParens(result.answer),
    checkWeirdNumbering(result.answer),
    checkHebrewRepetition(result.answer),
    checkHebrewDuplicateSentences(result.answer),
    checkOverconfidentPhrases(result.answer),
    checkRomajiPresence(result.question, result.answer),
    checkKnownVerbErrors(result.answer),
    checkSemanticNaturalness(result.answer),
    checkParticleConfusion(result.answer),
    checkKireiClassification(result.question, result.answer),
    checkSukiParticle(result.question, result.answer),
    checkToVsWo(result.question, result.answer),
    checkMixedLanguageGarbage(result.answer),
    checkRomajiAccuracy(result.answer),
    checkPlaceholderText(result.answer),
    checkLookupAnswerQuality(result.topic, result.question, result.answer),
    checkLookupTeachingEscape(result.topic, result.question, result.answer),
    checkNegationTypeConfusion(result.question, result.answer),
  ];

  if (result.type === "followup" && result.previousTurn) {
    findings.push(
      checkFollowupContextReference(result.answer, result.previousTurn),
      checkFollowupNotGeneric(result.answer, result.question, result.previousTurn),
      checkFollowupNoUncertainty(result.answer),
    );
  }

  const status = findings.every((f) => f.passed) ? "PASS" : "FAIL";
  return { id: result.id, topic: result.topic, question: result.question, status, findings };
}

export function makeSkipReport(id: string, topic: string, question: string, reason: string): QuestionReport {
  return {
    id,
    topic,
    question,
    status: "SKIP",
    findings: [],
    error: reason,
  };
}

// ─── Report formatting ────────────────────────────────────────────────────────

export function formatReport(reports: QuestionReport[], runTimestamp: string): string {
  const total = reports.length;
  const passed = reports.filter((r) => r.status === "PASS").length;
  const skipped = reports.filter((r) => r.status === "SKIP").length;
  const failed = total - passed - skipped;

  // Count issue frequency across all reports
  const issueFreq = new Map<string, number>();
  for (const r of reports) {
    for (const f of r.findings) {
      if (!f.passed) issueFreq.set(f.check, (issueFreq.get(f.check) ?? 0) + 1);
    }
  }
  const topIssues = [...issueFreq.entries()].sort((a, b) => b[1] - a[1]);

  const lines: string[] = [
    "# Sensei Eval — Critic Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Source: evals/runs/latest/answers.json`,
    `Run timestamp: ${runTimestamp}`,
    "",
    "---",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Total questions | ${total} |`,
    `| Passed | ${passed} ✅ |`,
    `| Failed | ${failed} ❌ |`,
    ...(skipped > 0 ? [`| Skipped (needs context) | ${skipped} ⏭ |`] : []),
    "",
  ];

  if (topIssues.length > 0) {
    lines.push("### Most Common Issues");
    lines.push("");
    lines.push("| Issue type | Occurrences |");
    lines.push("|---|---|");
    for (const [check, count] of topIssues) {
      lines.push(`| \`${check}\` | ${count} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  for (const report of reports) {
    const icon = report.status === "PASS" ? "✅" : report.status === "SKIP" ? "⏭" : "❌";
    lines.push(`## ${report.id} — ${report.topic} — ${report.status} ${icon}`);
    lines.push("");
    lines.push(`**Question:** ${report.question}`);
    lines.push("");

    if (report.error) {
      lines.push(`> ⚠️ Run error: \`${report.error}\``);
      lines.push("");
      lines.push("---");
      lines.push("");
      continue;
    }

    const failures = report.findings.filter((f) => !f.passed);
    const passes = report.findings.filter((f) => f.passed);

    if (failures.length === 0) {
      lines.push("All checks passed.");
    } else {
      lines.push("### Problems");
      lines.push("");
      for (const f of failures) {
        lines.push(`#### \`${f.check}\``);
        lines.push("");
        if (f.excerpt) lines.push(`- **Excerpt:** ${f.excerpt}`);
        if (f.detail) lines.push(`- **Detail:** ${f.detail}`);
        if (f.likelyCause) lines.push(`- **Likely cause:** ${f.likelyCause}`);
        if (f.suggestedFix) lines.push(`- **Suggested fix:** ${f.suggestedFix}`);
        lines.push("");
      }
    }

    if (passes.length > 0) {
      lines.push(`<details><summary>Passing checks (${passes.length})</summary>`);
      lines.push("");
      for (const f of passes) lines.push(`- ✅ \`${f.check}\``);
      lines.push("");
      lines.push("</details>");
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  if (!fs.existsSync(ANSWERS_PATH)) {
    console.error("Answers file not found:", ANSWERS_PATH);
    console.error("Run `npm run eval:sensei` first.");
    process.exit(1);
  }

  const answers: EvalResult[] = JSON.parse(fs.readFileSync(ANSWERS_PATH, "utf-8"));
  const runTimestamp = answers[0]?.timestamp ?? "unknown";

  console.log(`Critiquing ${answers.length} answers${IS_SMOKE ? " [smoke]" : ""}...`);

  const reports = answers.map(critiqueOne);
  const report = formatReport(reports, runTimestamp);

  fs.writeFileSync(REPORT_PATH, report, "utf-8");

  const passed  = reports.filter((r) => r.status === "PASS").length;
  const skipped = reports.filter((r) => r.status === "SKIP").length;
  const topIssue = [...reports.flatMap((r) => r.findings.filter((f) => !f.passed).map((f) => f.check))]
    .reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});
  const sorted = Object.entries(topIssue).sort((a, b) => b[1] - a[1]);

  console.log(`Result: ${passed}/${reports.length} passed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
  if (sorted.length > 0) console.log(`Top issue: ${sorted[0]![0]} (${sorted[0]![1]}×)`);
  console.log(`Report saved to: ${REPORT_PATH}`);
}

if (require.main === module) {
  main();
}
