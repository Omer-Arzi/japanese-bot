import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Chunk {
  id: string;
  sourceFile: string;
  sourceType: string;
  lessonNumber: number | null;
  chunkIndex: number;
  text: string;
}

type ConfidenceType = "explicit-teaching" | "grammar-reference" | "incidental-mention";

interface TopicDefinition {
  key: string;
  aliases: string[];
}

interface TopicMatch {
  chunkId: string;
  sourceType: string;
  sourceFile: string;
  lessonNumber: number | null;
  confidence: ConfidenceType;
  excerpt: string;
  matchedAliases: string[];
}

interface TopicSummary {
  totalMatches: number;
  hasLessonEvidence: boolean;
  hasGrammarReference: boolean;
  hasIncidental: boolean;
  lessonNumbers: number[];
}

interface TopicEntry {
  key: string;
  aliases: string[];
  matches: TopicMatch[];
  summary: TopicSummary;
}

type TopicIndex = Record<string, TopicEntry>;

// ─── Topic definitions ────────────────────────────────────────────────────────
// Each entry defines one indexable topic with all surface forms that signal it.

const TOPIC_DEFINITIONS: TopicDefinition[] = [
  {
    key: "te-form",
    aliases: [
      "te-form", "te form", "て-form", "て form", "て形",
      "食べて", "飲んで", "行って", "書いて", "聞いて", "見て", "して", "来て",
      "te form conjugation", "verb te", "connecting form",
    ],
  },
  {
    key: "particle-wa",
    aliases: ["は", "wa particle", "topic marker", "topic particle", "topic は"],
  },
  {
    key: "particle-ga",
    aliases: ["が", "ga particle", "subject marker", "subject particle", "subject が"],
  },
  {
    key: "particles-wa-ga",
    aliases: ["は vs が", "wa vs ga", "は and が", "wa and ga", "topic vs subject"],
  },
  {
    key: "particle-wo",
    aliases: ["を", "wo particle", "object marker", "direct object marker", "direct object"],
  },
  {
    key: "particle-ni",
    aliases: [
      "に", "ni particle", "direction particle", "destination particle",
      "に direction", "location に", "time に", "indirect object に",
    ],
  },
  {
    key: "particle-de",
    aliases: [
      "で", "de particle", "location of action", "action location",
      "で location", "means particle", "instrument particle",
    ],
  },
  {
    key: "particles-ni-de",
    aliases: ["に vs で", "ni vs de", "に and で", "location comparison"],
  },
  {
    key: "particle-to",
    aliases: ["と", "to particle", "と particle", "listing and", "noun list と"],
  },
  {
    key: "particle-no",
    aliases: ["の", "no particle", "possession の", "の possession", "genitive の"],
  },
  {
    key: "particle-mo",
    aliases: ["も", "mo particle", "も particle", "also particle", "too particle"],
  },
  {
    key: "particle-he",
    aliases: ["へ", "he particle", "direction へ", "towards particle"],
  },
  {
    key: "masu-form",
    aliases: [
      "ます", "masu", "ます form", "masu form", "polite form",
      "ます conjugation", "masu conjugation", "verb ます",
    ],
  },
  {
    key: "negative-form",
    aliases: [
      "ません", "ない", "negative form", "nai form", "masen",
      "verb negation", "negative verb", "negative conjugation",
      "ません negative", "ない negative",
    ],
  },
  {
    key: "past-tense",
    aliases: [
      "ました", "mashita", "past tense", "た形", "ta-form",
      "past tense verb", "verb past", "ました past", "past conjugation",
    ],
  },
  {
    key: "past-negative",
    aliases: [
      "ませんでした", "masen deshita", "past negative",
      "negative past", "ませんでした past",
    ],
  },
  {
    key: "na-adjectives",
    aliases: [
      "な形容詞", "na adjective", "na-adjective", "adjective な",
      "na adjective conjugation", "きれい", "しずか", "有名", "元気",
    ],
  },
  {
    key: "i-adjectives",
    aliases: [
      "い形容詞", "i adjective", "i-adjective", "adjective い",
      "i adjective conjugation", "おいしい", "たかい", "おおきい", "ちいさい",
    ],
  },
  {
    key: "adjective-negative",
    aliases: [
      "adjective negative", "くない", "じゃない", "くありません",
      "adjective negation",
    ],
  },
  {
    key: "existence-verbs",
    aliases: [
      "います", "あります", "imasu", "arimasu",
      "existence verb", "iru aru", "いる", "ある",
      "animate inanimate", "います vs あります",
    ],
  },
  {
    key: "demonstratives",
    aliases: [
      "これ", "それ", "あれ", "この", "その", "あの",
      "demonstrative", "kore sore are", "kono sono ano",
      "this that over there",
    ],
  },
  {
    key: "possession",
    aliases: [
      "possession", "possessive", "の possession", "my your his",
      "わたしの", "あなたの", "possessive の",
    ],
  },
  {
    key: "sentence-structure",
    aliases: [
      "sentence structure", "word order", "SOV", "basic sentence",
      "Japanese sentence", "subject object verb", "basic grammar",
    ],
  },
  {
    key: "hiragana",
    aliases: ["hiragana", "ひらがな", "hiragana characters", "hiragana writing"],
  },
  {
    key: "katakana",
    aliases: ["katakana", "カタカナ", "katakana characters", "katakana writing"],
  },
  {
    key: "numbers-counting",
    aliases: [
      "numbers", "counting", "numeral", "counter",
      "一", "二", "三", "四", "五", "いち", "に", "さん",
      "一枚", "一本", "一冊",
    ],
  },
  {
    key: "time-expressions",
    aliases: [
      "time", "time expression", "clock", "what time", "o'clock",
      "何時", "時", "分", "morning evening", "朝", "夜", "午前", "午後",
    ],
  },
  {
    key: "greetings",
    aliases: [
      "greeting", "おはよう", "こんにちは", "こんばんは", "ありがとう",
      "すみません", "hajimemashite", "はじめまして",
      "yoroshiku", "よろしく",
    ],
  },
  {
    key: "self-introduction",
    aliases: [
      "self introduction", "introduce yourself", "自己紹介",
      "わたしは", "watashi wa", "my name is", "I am",
    ],
  },
  {
    key: "invitations-requests",
    aliases: [
      "invitation", "request", "ませんか", "ましょう", "masen ka", "masho",
      "let's", "shall we", "would you like", "て form request",
    ],
  },
  {
    key: "frequency-adverbs",
    aliases: [
      "frequency", "adverb", "いつも", "よく", "たいてい", "ときどき", "あまり", "ぜんぜん",
      "always sometimes never often", "frequency adverb",
    ],
  },
  {
    key: "location-place",
    aliases: [
      "location", "place", "where", "ここ", "そこ", "あそこ", "どこ",
      "here there", "place particle", "location word",
    ],
  },
];

// ─── Confidence classification ────────────────────────────────────────────────

// Source types that represent formally taught material linked to a lesson number
const LESSON_SOURCE_TYPES = new Set(["lesson", "summary"]);

// Source types that are grammar references (teaching material without lesson numbers)
const GRAMMAR_REF_SOURCE_TYPES = new Set(["grammar", "genki"]);

// Source types that are incidental — examples, exercises, vocab lists
const INCIDENTAL_SOURCE_TYPES = new Set(["workbook", "vocab"]);

function classifyConfidence(chunk: Chunk): ConfidenceType {
  // Lesson/summary WITH a lesson number → explicitly taught
  if (LESSON_SOURCE_TYPES.has(chunk.sourceType) && chunk.lessonNumber !== null) {
    return "explicit-teaching";
  }
  // Grammar/genki source (fundamentals.pdf etc.) → grammar reference
  if (GRAMMAR_REF_SOURCE_TYPES.has(chunk.sourceType)) {
    return "grammar-reference";
  }
  // Lesson/summary WITHOUT lesson number → treat as grammar reference
  if (LESSON_SOURCE_TYPES.has(chunk.sourceType)) {
    return "grammar-reference";
  }
  // Workbook / vocab → incidental mention
  if (INCIDENTAL_SOURCE_TYPES.has(chunk.sourceType)) {
    return "incidental-mention";
  }
  // Unknown source type — fall back to incidental
  return "incidental-mention";
}

// ─── Excerpt extraction ───────────────────────────────────────────────────────

const EXCERPT_RADIUS = 150;

function extractExcerpt(text: string, matchIndex: number, matchLen: number): string {
  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end   = Math.min(text.length, matchIndex + matchLen + EXCERPT_RADIUS);
  let excerpt = text.slice(start, end).replace(/\n+/g, " ").trim();
  if (start > 0)         excerpt = "…" + excerpt;
  if (end < text.length) excerpt = excerpt + "…";
  return excerpt;
}

// ─── Core matching ────────────────────────────────────────────────────────────

function findTopicMatches(chunks: Chunk[], topic: TopicDefinition): TopicMatch[] {
  const matches: TopicMatch[] = [];

  for (const chunk of chunks) {
    const textLower      = chunk.text.toLowerCase();
    const matchedAliases: string[] = [];
    let firstMatchIndex  = -1;
    let firstMatchLen    = 0;

    for (const alias of topic.aliases) {
      const aliasLower = alias.toLowerCase();
      const idx        = textLower.indexOf(aliasLower);
      if (idx === -1) continue;

      matchedAliases.push(alias);

      if (firstMatchIndex === -1) {
        firstMatchIndex = idx;
        firstMatchLen   = alias.length;
      }
    }

    if (matchedAliases.length === 0) continue;

    matches.push({
      chunkId:       chunk.id,
      sourceType:    chunk.sourceType,
      sourceFile:    chunk.sourceFile,
      lessonNumber:  chunk.lessonNumber,
      confidence:    classifyConfidence(chunk),
      excerpt:       extractExcerpt(chunk.text, firstMatchIndex, firstMatchLen),
      matchedAliases: [...new Set(matchedAliases)],
    });
  }

  return matches;
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(matches: TopicMatch[]): TopicSummary {
  const lessonNumbers = [
    ...new Set(
      matches
        .filter((m) => m.confidence === "explicit-teaching" && m.lessonNumber !== null)
        .map((m) => m.lessonNumber as number),
    ),
  ].sort((a, b) => a - b);

  return {
    totalMatches:      matches.length,
    hasLessonEvidence: matches.some((m) => m.confidence === "explicit-teaching"),
    hasGrammarReference: matches.some((m) => m.confidence === "grammar-reference"),
    hasIncidental:     matches.some((m) => m.confidence === "incidental-mention"),
    lessonNumbers,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const chunksPath = path.join(process.cwd(), "data", "all-chunks.json");
  const outputPath = path.join(process.cwd(), "data", "topic-index.json");

  if (!fs.existsSync(chunksPath)) {
    console.error(`Chunks file not found: ${chunksPath}`);
    process.exit(1);
  }

  const chunks: Chunk[] = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
  console.log(`Loaded ${chunks.length} chunks.`);

  const index: TopicIndex = {};

  for (const topic of TOPIC_DEFINITIONS) {
    const matches = findTopicMatches(chunks, topic);
    const summary = buildSummary(matches);

    index[topic.key] = {
      key:     topic.key,
      aliases: topic.aliases,
      matches,
      summary,
    };

    const lessonStr = summary.lessonNumbers.length > 0
      ? `lessons [${summary.lessonNumbers.join(", ")}]`
      : summary.hasGrammarReference
        ? "grammar-ref only"
        : summary.hasIncidental
          ? "incidental only"
          : "no matches";

    console.log(
      `  ${topic.key.padEnd(22)}  ` +
      `${String(matches.length).padStart(3)} match(es)  ` +
      `teach=${summary.hasLessonEvidence ? "✓" : "✗"}  ` +
      `ref=${summary.hasGrammarReference ? "✓" : "✗"}  ` +
      `incid=${summary.hasIncidental ? "✓" : "✗"}  ` +
      lessonStr,
    );
  }

  fs.writeFileSync(outputPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  console.log(`\nTopic index written to ${outputPath}`);

  // Final summary
  const withLesson  = Object.values(index).filter((e) => e.summary.hasLessonEvidence).length;
  const withGrammar = Object.values(index).filter((e) => e.summary.hasGrammarReference).length;
  const withNone    = Object.values(index).filter((e) => e.summary.totalMatches === 0).length;
  console.log(`\nSummary: ${TOPIC_DEFINITIONS.length} topics`);
  console.log(`  ${withLesson} with explicit lesson evidence`);
  console.log(`  ${withGrammar} with grammar-reference evidence`);
  console.log(`  ${withNone} with zero matches (topic not yet in indexed materials)`);
}

main();
