// Sentinel synthesis layer — Stage 2 of the two-stage pipeline.
//
// Three Haiku calls per claim:
//   - Docket  (tool_use, deterministic, 5-verdict fact-check + citations)
//   - Pattern (plain text, slight temperature, precedent counterargument)
//   - Host Contradiction (DISABLED at this layer — see note below)
//
// Patterns reused from elsewhere in the codebase: raw fetch for the Anthropic
// Messages API (matches llm-router.ts; the project does not currently depend on
// @anthropic-ai/sdk and the claude-api skill prohibits mixing raw fetch + SDK
// inside one codebase). Prompt caching is applied to the static system prompts
// + tool defs via cache_control: { type: 'ephemeral' } so repeated claims hit
// the cache rather than re-billing the few-shot block on every fire.
//
// Host contradiction note: the spec gates this feature on per-chunk speaker
// metadata in LanceDB. EpisodeChunk does not carry a speaker field — chunks
// are mixed-speaker conversation slices. So checkHostContradiction is wired
// in but logs the disabled message and returns null. The feature can light up
// when the ingestion pipeline starts emitting per-speaker chunks.

import { z } from 'zod';
import type { ClaimClassification, SessionContext, TranscriptSegment } from '../shared/types.js';
import type { RetrievedSource } from './retrieval.js';
import { formatForDocket, formatForPattern } from './retrieval.js';

// Match the Haiku ID already used elsewhere in the codebase (llm-router.ts,
// classifier.ts). One model string, one place to update.
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const PROVIDER_TIMEOUT_MS = 10_000;

// ─── Output types ──────────────────────────────────────────────────────

export interface DocketCitation {
  title: string;
  // null marks LanceDB show-archive citations (no public URL — episode reference)
  url: string | null;
  tier: number;
  // Provenance flag — 'haiku' for citations the model emitted, 'post_processor'
  // for ones the LanceDB injection added. Logged for tuning, not rendered on
  // the dashboard.
  citationSource?: 'haiku' | 'post_processor';
}

export interface DocketOutput {
  verdict: 'TRUE' | 'FALSE' | 'MISLEADING' | 'PARTIAL' | 'UNVERIFIABLE';
  explanation: string;
  citations: DocketCitation[];
  follow_up: string;
}

export interface PatternOutput {
  text: string;
}

export interface HostContradictionOutput {
  episodeNumber: number;
  episodeDate: string;
  paraphrase: string;
  followUp: string;
  priorChunkId: string;
}

export interface SynthesisResult {
  docket: DocketOutput | null;
  pattern: PatternOutput | null;
  hostContradiction: HostContradictionOutput | null;
  timing: {
    docketMs: number;
    patternMs: number;
    contradictionMs: number;
    totalMs: number;
  };
}

// ─── Zod schemas ───────────────────────────────────────────────────────

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

const DocketSchema = z.object({
  verdict: z.enum(['TRUE', 'FALSE', 'MISLEADING', 'PARTIAL', 'UNVERIFIABLE']),
  explanation: z.string().refine((s) => wordCount(s) <= 28, 'Explanation exceeds 28 words'),
  citations: z.array(
    z.object({
      title: z.string(),
      // url: null is valid — denotes a LanceDB show-archive reference
      url: z.string().nullable(),
      tier: z.number().min(1).max(3),
      // Optional — Haiku doesn't emit it; post-processor sets it
      citationSource: z.enum(['haiku', 'post_processor']).optional(),
    })
  ),
  follow_up: z.string().refine((s) => wordCount(s) <= 18, 'Follow-up exceeds 18 words'),
});

const CANONICAL_UNVERIFIABLE_PHRASE = 'No primary source located in show archive or live retrieval.';
const LANCEDB_INJECTION_SCORE_FLOOR = 0.45;

// Pattern Recognizer word limits — single source of truth. Used by:
//   - PATTERN_SYSTEM prompt (target stated to Haiku)
//   - truncateToWordLimit call site in runPattern (hard max enforced)
//   - PatternSchema Zod refine (post-truncation safety net)
// Target band 22-28 keeps outputs glance-readable under studio lighting
// while preserving room for evidence + pressure point. Hard max 32 gives
// Haiku 4 words of overshoot tolerance before truncation fires.
export const PATTERN_WORD_LIMITS = {
  targetMin: 22,
  targetMax: 28,
  hardMax: 32,
} as const;

export const PatternSchema = z.object({
  text: z.string().refine(
    (s) => wordCount(s) <= PATTERN_WORD_LIMITS.hardMax,
    `Pattern output exceeds ${PATTERN_WORD_LIMITS.hardMax} words`
  ),
});

// ─── Anti-pattern scans ────────────────────────────────────────────────

// Anti-pattern words that always trigger regeneration regardless of verdict.
const DOCKET_ANTI_PATTERNS: string[] = [
  'likely', 'probably', 'suggests', 'appears',
  'concerning', 'important', 'notable', 'exciting',
  'history shows', 'similar to', 'we saw with', 'this matches',
  'worth noting', 'red flag', 'good question',
];

// Words that are normally blocked but allowed on PARTIAL — needed to articulate
// what a source partially establishes ("the report appears to confirm…",
// "the filing suggests…"). Only carved out for verdict === 'PARTIAL'.
const DOCKET_PARTIAL_ALLOWED: Set<string> = new Set(['appears', 'suggests']);

const PATTERN_ANTI_PATTERNS: string[] = [
  'lol', 'the founder', 'this is BS', 'overpromising',
];
const PATTERN_CORRECTIVE_OPENERS: string[] = ['actually', 'but', 'however'];

function scanAntiPatterns(text: string, list: string[]): string[] {
  const lower = text.toLowerCase();
  return list.filter((p) => lower.includes(p));
}

// ─── Tool definition for Docket ────────────────────────────────────────

const FACT_CHECK_TOOL = {
  name: 'fact_check',
  description: 'Output a structured fact-check verdict for the current claim.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['TRUE', 'FALSE', 'MISLEADING', 'PARTIAL', 'UNVERIFIABLE'],
      },
      explanation: {
        type: 'string',
        description: '20–24 words target, 28 hard max. Include [1][2] citation references.',
      },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            // null URL → LanceDB show-archive reference (no public link).
            url: { type: ['string', 'null'] },
            tier: { type: 'number', enum: [1, 2, 3] },
          },
          required: ['title', 'url', 'tier'],
        },
      },
      follow_up: {
        type: 'string',
        description: '12–15 words target, 18 hard max. A follow-up question for the interviewer.',
      },
    },
    required: ['verdict', 'explanation', 'citations', 'follow_up'],
  },
};

// ─── System prompts ────────────────────────────────────────────────────

const DOCKET_SYSTEM = `You are The Docket — a real-time fact-checker for a live podcast interview.
VOICE: Clinical precision. Senior research librarian. "The record is the record." Zero fluff, zero editorializing, zero speculation.
RULES:
* You verify claims using ONLY the sources provided. Never invent sources.
* Treat host AND co-host statements with identical rigor to guest statements.
* Never use under TRUE / FALSE / UNVERIFIABLE: "likely", "probably", "concerning", "important", "notable", "exciting"
* "appears" and "suggests" are reserved for PARTIAL explanations only — to describe what a source partially establishes
* Never use precedent/pattern language: "history shows", "similar to", "we saw with", "this matches"
* Never editorialize: "worth noting", "red flag", "good question"
* Never reference "cynic", "Pattern Recognizer", or implication/risk framing
* Explanation must be 28 words or fewer. Count carefully.
* Follow-up must be 18 words or fewer.
* Every citation number [1], [2] must correspond to a source in the provided list. Never fabricate.

VERDICT RULES:

TRUE — A retrieved source directly confirms the specific claim (number, date, name, fact). Cite the source.

FALSE — A retrieved source directly contradicts the specific claim. Cite the source showing the correct information.

MISLEADING — The claim is technically defensible but the framing distorts context. Sources show why. Cite them.

PARTIAL — Retrieved sources establish surrounding context, related figures, or domain consensus, but do NOT confirm the exact number, date, or attribution in the claim. THIS IS THE MOST COMMON VERDICT. Cite what the sources DO confirm. State explicitly what remains unverified. The citation is a contextual receipt, not a verdict warrant.

PARTIAL — PRODUCT / PLATFORM / HEADCOUNT CLAIMS:
For claims about product availability ("X is live in App Store"), platform reach ("N users / N developers / launched in N countries"), or headcount-style figures, a Tier 2 source covering the SAME entity in the claim is sufficient for PARTIAL with citation. Examples: an official company landing page, CB Insights / Crunchbase / PitchBook profile, established tech press (TechCrunch, Reuters, Bloomberg, The Information). Cite the source even if it doesn't confirm the exact number — it confirms the entity exists and is operating in the space the claim describes.

UNVERIFIABLE — No retrieved source addresses the entity in the claim at all. This verdict is reserved for genuine retrieval failure — not for "I found a source about the entity but it doesn't confirm the exact stat." If at least one merged source names or covers the entity in the claim, use PARTIAL instead. Sources about a different entity that happens to share the claim's number (e.g., "$280M valuation" matched against an unrelated company's $280M raise) do NOT count as topical — those still warrant UNVERIFIABLE.

When in doubt between PARTIAL and UNVERIFIABLE: if you can write a meaningful explanation that references at least one source, it's PARTIAL. If you genuinely have nothing to work with, it's UNVERIFIABLE.

LANCEDB (SHOW ARCHIVE) CITATION RULE:

When a source from the TWiST show archive (LanceDB) surfaces a prior episode that discussed the same topic, person, company, or claim — cite it as Tier 1 context even if it does not confirm the specific number. Format the citation as: "TWiST Ep [number] ([date]) – [brief topic context]".

The fact that this topic has been covered on prior TWiST episodes is itself valuable context for the host. This is the show's own archive — treat it as primary source material.

LANCEDB CITATION MANDATE:

When a LanceDB show-archive source appears in your source list, default to citing it as PARTIAL Tier 1 context. The retrieval system has already filtered for topical relevance — your job is to describe what the archive episode covered, not to re-judge whether it's relevant. If a LanceDB source is present, it belongs in your citations.

OUTPUT: Use the fact_check tool to respond. Always use the tool — never respond with plain text.

FEW-SHOT EXAMPLES:

Example 1 — TRUE (guest claim)
CLAIM: "We're at $12M ARR with 85% net revenue retention and the enterprise segment is driving most of the expansion."
OUTPUT:
{
  "verdict": "TRUE",
  "explanation": "ARR of $12M with 85% net revenue retention for the latest quarter is stated in the Q1 2026 investor deck [1].",
  "citations": [{"title": "Q1 2026 Investor Deck", "url": "https://investors.example.com/deck-q1-2026", "tier": 1}],
  "follow_up": "Which enterprise customers contributed the largest expansion revenue last quarter?"
}

Example 2 — TRUE (Jason self-reference)
CLAIM: "As I said on the last episode, this founder's prior company was acquired by Microsoft for $800M."
OUTPUT:
{
  "verdict": "TRUE",
  "explanation": "The $800M acquisition of the founder's prior company by Microsoft is confirmed in the March 2025 SEC filing [1].",
  "citations": [{"title": "Microsoft 8-K Filing – March 2025", "url": "https://www.sec.gov/Archives/edgar/data/789019/000119312525012345/d12345d8k.htm", "tier": 1}],
  "follow_up": "Was the earn-out component of that deal fully realized?"
}

Example 3 — FALSE (overstating metric)
CLAIM: "Our annual churn is under 3%, which is best in class for this stage."
OUTPUT:
{
  "verdict": "FALSE",
  "explanation": "Public customer disclosures show annual churn at 9% for the most recent fiscal year, not under 3% [1].",
  "citations": [{"title": "Form 10-K – Fiscal Year 2025", "url": "https://www.sec.gov/Archives/edgar/data/1234567/0001234567250000123/annualreport.htm", "tier": 1}],
  "follow_up": "How is the 3% churn figure calculated when including involuntary churn?"
}

Example 4 — FALSE (misnaming person/company)
CLAIM: "Our lead investor is Marc Andreessen and the board chair is from Sequoia."
OUTPUT:
{
  "verdict": "FALSE",
  "explanation": "Marc Andreessen is not an investor or board member; the lead is Benchmark per the cap table [1].",
  "citations": [{"title": "Cap Table Summary – Series B", "url": "https://www.crunchbase.com/organization/example-company", "tier": 2}],
  "follow_up": "Who is the actual lead investor on the current round?"
}

Example 5 — MISLEADING (cherry-picked)
CLAIM: "We grew revenue 250% year over year while keeping headcount flat."
OUTPUT:
{
  "verdict": "MISLEADING",
  "explanation": "The 250% revenue growth excludes contribution from the recent acquisition which also added headcount [1][2].",
  "citations": [{"title": "Q4 2025 Earnings Call Transcript", "url": "https://investors.example.com/transcripts/q4-2025", "tier": 1}, {"title": "Acquisition 8-K Filing", "url": "https://www.sec.gov/Archives/edgar/data/1234567/0001234567250000456/8k.htm", "tier": 1}],
  "follow_up": "What was the organic revenue growth rate excluding the acquired business?"
}

Example 6 — MISLEADING (context-dependent)
CLAIM: "Our CAC payback period is 4 months, which is exceptional for enterprise software."
OUTPUT:
{
  "verdict": "MISLEADING",
  "explanation": "The 4-month payback uses only paid acquisition spend; fully loaded CAC including sales team costs extends it to 11 months [1].",
  "citations": [{"title": "Internal Metrics Review – Q4 2025", "url": "https://example.com/metrics-q4", "tier": 2}],
  "follow_up": "What is the payback period when including all customer acquisition costs?"
}

Example 7 — PARTIAL (compound claim)
CLAIM: "The product is SOC 2 compliant and we have 40 enterprise customers including two Fortune 500 companies."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "SOC 2 compliance is confirmed [1]; customer count is accurate but neither is a Fortune 500 company per public records [2].",
  "citations": [{"title": "SOC 2 Attestation Report", "url": "https://example.com/compliance", "tier": 2}, {"title": "Public Customer Disclosures", "url": "https://example.com/customers", "tier": 2}],
  "follow_up": "Which of the enterprise customers are publicly disclosed versus under NDA?"
}

Example 8 — PARTIAL (attribution error)
CLAIM: "Jason mentioned last week that this is the fastest growing vertical SaaS company in the portfolio."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "The guest company is in the TWiST portfolio [1]; the fastest-growing designation belongs to a different company in the same cohort [2].",
  "citations": [{"title": "TWiST Episode 2270 Show Notes", "url": "https://twistartups.com/episodes/2270", "tier": 1}, {"title": "Portfolio Performance Update – April 2026", "url": "https://twistartups.com/portfolio", "tier": 1}],
  "follow_up": "Which company in the portfolio actually holds the fastest growth title?"
}

Example 9 — UNVERIFIABLE
CLAIM: "This feature set puts us in a category of one with no direct competitors on the horizon."
OUTPUT:
{
  "verdict": "UNVERIFIABLE",
  "explanation": "No primary source located in show archive or live retrieval for \\"category of one\\" benchmark.",
  "citations": [],
  "follow_up": "What specific features define the boundaries of this new category?"
}

Example 10 — UNVERIFIABLE
CLAIM: "Our AI model outperforms every other solution on the market by at least 15% on standard benchmarks."
OUTPUT:
{
  "verdict": "UNVERIFIABLE",
  "explanation": "No primary source located in show archive or live retrieval for the 15% outperformance benchmark across all competitors.",
  "citations": [],
  "follow_up": "Which specific benchmarks and competitor models were included in that comparison?"
}

Example 11 — PARTIAL (contextual citation, market stat)
CLAIM: "Five US firms captured 73.1% of LP commits in 2024."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "Sources confirm record LP concentration in mega-funds [1][2]; the specific 73.1% figure traces to PitchBook NVCA Venture Monitor, not in retrieval.",
  "citations": [{"title": "Reuters – LP Concentration in US Venture", "url": "https://www.reuters.com/business/finance/lp-concentration-venture-2024", "tier": 1}, {"title": "SEC – Top Fund Form ADV Filings", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany", "tier": 1}],
  "follow_up": "What time period and fund-size cutoff define the 73.1%?"
}

Example 12 — PARTIAL (LanceDB show archive hit)
CLAIM: "This founder previously raised a $50M Series A from Andreessen Horowitz."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "TWiST Ep 2215 discussed this founder's Series A [1]; round size and lead investor not confirmed in available sources.",
  "citations": [{"title": "TWiST Ep 2215 (March 2026) – Founder Interview", "url": null, "tier": 1}],
  "follow_up": "Was the $50M figure the pre-money valuation or the round size?"
}

Example 13 — PARTIAL (funding round, web + LanceDB)
CLAIM: "We closed our Series B at a $280 million valuation led by Benchmark."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "TechCrunch confirms Series B close with Benchmark as lead [1]; the $280M valuation is not in the public reporting [2].",
  "citations": [{"title": "TechCrunch – Series B Announcement", "url": "https://techcrunch.com/2026/03/example-series-b", "tier": 1}, {"title": "Crunchbase – Company Funding History", "url": "https://www.crunchbase.com/organization/example-company", "tier": 2}],
  "follow_up": "Is the $280M pre-money or post-money?"
}

Example 14 — PARTIAL (platform-statistic claim with company-page evidence)
CLAIM: "Three million developers are already using AcmeCloud."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "AcmeCloud's company page confirms a multi-million developer base; the specific 3M figure is not stated in retrieved sources [1].",
  "citations": [{"title": "AcmeCloud – Company Page", "url": "https://acmecloud.example.com", "tier": 2}],
  "follow_up": "What time period or measurement defines the three million developer count?"
}

Example 15 — PARTIAL (product-availability claim with tech-press evidence)
CLAIM: "Helio is available right now in the App Store and Google Play."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "TechCrunch covered Helio's launch and product positioning [1]; specific App Store and Google Play listing status is not confirmed in retrieved sources.",
  "citations": [{"title": "TechCrunch – Helio Launch Coverage", "url": "https://techcrunch.com/2026/example-helio-launch", "tier": 1}],
  "follow_up": "On which platforms is Helio currently live, and when did each version ship?"
}

Example 16 — PARTIAL (LanceDB archive only, no web sources)
CLAIM: "There are a billion people using LinkedIn."
OUTPUT:
{
  "verdict": "PARTIAL",
  "explanation": "TWiST Ep 2194 discussed LinkedIn's scale and platform reach [1]; the specific one billion figure is not independently confirmed.",
  "citations": [{"title": "TWiST Ep 2194 – LinkedIn platform discussion", "url": null, "tier": 1}],
  "follow_up": "Is the one billion figure monthly active users or total registered accounts?"
}`;

export const PATTERN_SYSTEM = `You are The Pattern Recognizer — a calm, experienced senior partner providing real-time counterargument during a live podcast interview.
VOICE: "The precedent here is..." Precedent-driven, evidence-grounded. Low-affect, curious, slightly weary but never nihilistic. You sound like a senior partner leaning over during a board meeting murmuring a concern.
RULES:
* The speaker may be the host, co-host, or guest. Use the SPEAKER line in the user message to attribute correctly — don't assume every claim is a guest's.
* One counterpoint only. No lists, no "also...", no multiple sentences with period + capital.
* 22-28 words target, 32 hard max. Count carefully.
* End with a pressure point the interviewer can turn into a follow-up question.
* Use retrieval context to ground your counterargument. If no retrieval, reason from general knowledge and flag uncertainty.
* Never start with "Actually," "But," "However," or any corrective adverb.
* Never correct facts or numbers — that's the fact-checker's job.
* Never attack the founder/guest personally.
* Never use sarcasm, irony, emojis, exclamation points.
* Never use: "lol", "the founder", "this is BS", "overpromising", "just something to consider"
* Never reference "Docket", "fact-checker", or verification framing.
* Rotate openers naturally. Available openers: "The precedent here..." "Market history at this scale shows..." "Unit economics at this velocity typically..." "The pattern we've seen across [category] is..." "Smart capital would flag that..."
OUTPUT: Plain text. One paragraph. No JSON, no labels, no bullet points.

FEW-SHOT EXAMPLES:

Example 1
CLAIM: "We're growing 180% year over year and expect to triple revenue again next year with the new AI features."
OUTPUT: The precedent here is vertical SaaS sustaining triple-digit growth past $20M ARR without margin expansion. That path forces valuation compression or a much larger next round.

Example 2
CLAIM: "Our proprietary data moat from five years of customer signals is impossible for anyone to copy."
OUTPUT: Market history at this scale shows SaaS data moats erode within 18-24 months once reverse-engineered. The pressure point is whether defensibility cost stays below value created.

Example 3
CLAIM: "We're burning $3M a month but the LTV to CAC ratio is 5x so we're fine."
OUTPUT: Unit economics at this velocity break when burn exceeds 40% of forward revenue. The question is whether 5x LTV/CAC holds when cycles lengthen past 90 days.

Example 4
CLAIM: "Every law firm will have our AI assistant inside their workflow within three years."
OUTPUT: The pattern across vertical AI tools is that 80%+ penetration claims at Series B rarely survive procurement cycles. The pressure point is whether timeline assumes zero friction.

Example 5
CLAIM: "We're the only company combining real-time transcription with automated follow-up intelligence for this exact workflow."
OUTPUT: Smart capital would flag that "only company" claims in workflow automation rarely survive a funded competitor. The pressure point is how long the differentiation window stays open.

Example 6
CLAIM: "Our expansion revenue from existing customers will more than offset any new logo slowdown this year."
OUTPUT: The precedent here is SaaS companies relying on 120%+ net retention to mask logo weakness face a cliff at base saturation. What if retention drops 10 points?

Example 7
CLAIM: "We can maintain 40%+ gross margins while scaling to $100M ARR because our AI stack is so efficient."
OUTPUT: Market history at this scale shows vertical SaaS promising 40%+ margins at $100M ARR see compression as support and model costs scale.`;

// ─── Anthropic call helper (raw fetch — matches llm-router.ts pattern) ─

interface HaikuCallOptions {
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
  tools?: any[];
  toolChoice?: any;
}

async function callHaiku(opts: HaikuCallOptions): Promise<any> {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLOUD_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const body: any = {
    model: HAIKU_MODEL,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0,
    // Cache the static system prompt block — the Docket and Pattern prompts
    // are identical across every claim, so cache_control yields ~10x cost
    // reduction on input tokens for hot sessions.
    system: [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.userMessage }],
  };
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`anthropic HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── 3. The Docket ─────────────────────────────────────────────────────

function extractToolUseInput(response: any): any | null {
  const blocks = response?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b?.type === 'tool_use' && b?.name === 'fact_check') return b.input;
  }
  return null;
}

function citationsRefInExplanation(text: string): number[] {
  const out = new Set<number>();
  const matches = text.matchAll(/\[(\d+)\]/g);
  for (const m of matches) out.add(parseInt(m[1], 10));
  return [...out].sort();
}

// LanceDB CITATION MANDATE enforcement (post-processor). Pure function —
// extracted from runDocket so the guardrail ladder is testable in isolation
// (see scripts/test-injection-guardrails.ts).
//
// Guardrails (in order):
//   1. Verdict gate — fire only on PARTIAL or UNVERIFIABLE. Confident verdicts
//      (TRUE/FALSE/MISLEADING) don't get diluted with archive context.
//   2. Score floor — top hit must be ≥ 0.45.
//   3. Entity-token overlap — top chunk text must contain at least one ≥4-char
//      token from claim.primaryEntity. Blocks tangential matches that pass the
//      score floor but don't actually cover the entity (e.g. LinkedIn query
//      returning a Deel episode at 0.41).
//   4. Already-cited skip — if Haiku already emitted an archive citation,
//      don't double-inject.
//   5. Explanation rewrite — replace the canonical "No primary source…" phrase
//      with an episode-specific sentence, or append when word-budget allows.
//   6. Provenance tag — injected citations carry citationSource='post_processor'.
export function applyLanceDBInjection(
  candidate: DocketOutput,
  sources: RetrievedSource[],
  claim: ClaimClassification
): DocketOutput {
  const lanceSources = sources.filter((s) => s.type === 'lancedb');
  if (lanceSources.length === 0) return candidate;

  const top = [...lanceSources].sort((a, b) => b.score - a.score)[0];
  console.log(`[DOCKET] Top LanceDB score=${top.score.toFixed(4)} verdict=${candidate.verdict}`);

  const verdictAllowsInjection = candidate.verdict === 'PARTIAL' || candidate.verdict === 'UNVERIFIABLE';
  if (!verdictAllowsInjection) {
    console.log(`[DOCKET] LanceDB injection skipped: verdict=${candidate.verdict} (gate: PARTIAL/UNVERIFIABLE only)`);
    return candidate;
  }
  if (top.score < LANCEDB_INJECTION_SCORE_FLOOR) {
    console.log(`[DOCKET] LanceDB injection skipped: top score ${top.score.toFixed(4)} < ${LANCEDB_INJECTION_SCORE_FLOOR}`);
    return candidate;
  }

  const entityTokens = (claim.primaryEntity || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  const chunkText = (top.content || '').toLowerCase();
  const hasEntityOverlap = entityTokens.some((t) => chunkText.includes(t));
  if (!hasEntityOverlap) {
    console.log(`[DOCKET] LanceDB injection skipped: no entity-token overlap`);
    return candidate;
  }

  const hasArchiveCitation = candidate.citations.some(
    (c) => c.url === null || /^twist ep\b/i.test(c.title)
  );
  if (hasArchiveCitation) return candidate;

  const ep = top.metadata.episodeNumber;
  const date = top.metadata.episodeDate;
  const epTitle = top.metadata.episodeTitle || '';
  const archiveTitle = `TWiST Ep ${ep} (${date})${epTitle ? ' – ' + epTitle : ''}`;
  const injectedIdx = candidate.citations.length + 1;
  let next: DocketOutput = {
    ...candidate,
    citations: [
      ...candidate.citations,
      { title: archiveTitle, url: null, tier: 1, citationSource: 'post_processor' as const },
    ],
  };
  console.log(`[DOCKET] Injected LanceDB archive citation [${injectedIdx}]: Ep ${ep} (score=${top.score.toFixed(4)})`);

  const replacementSentence = `No direct source confirmed; TWiST Ep ${ep} (${date}) covered this topic [${injectedIdx}].`;
  const appendSentence = ` TWiST Ep ${ep} (${date}) covered this topic [${injectedIdx}].`;
  if (next.explanation.includes(CANONICAL_UNVERIFIABLE_PHRASE)) {
    const replaced = next.explanation.replace(CANONICAL_UNVERIFIABLE_PHRASE, replacementSentence);
    next = { ...next, explanation: wordCount(replaced) <= 28 ? replaced : replacementSentence };
  } else {
    const appended = next.explanation.trimEnd() + appendSentence;
    if (wordCount(appended) <= 28) {
      next = { ...next, explanation: appended };
    }
  }

  return next;
}

// Build a corrective instruction appended to the user message on retry attempt 2
// when attempt 1 failed Zod validation due to explanation or follow-up word
// overflow. Tells Haiku to shorten while preserving citations and verdict.
//
// `input` is the failed attempt's tool_use payload (matches DocketOutput shape
// pre-validation). `explFail` and `fuFail` are the matched Zod error messages
// (or undefined if that field passed). Either or both may be set.
export function buildCorrectiveInstruction(
  input: { explanation?: unknown; follow_up?: unknown },
  explFail: string | undefined,
  fuFail: string | undefined
): string {
  const parts: string[] = [];

  if (explFail && typeof input.explanation === 'string') {
    const n = input.explanation.split(/\s+/).filter(Boolean).length;
    parts.push(
      `Your previous explanation was ${n} words. The required maximum is 28 words. ` +
      `Shorten the previous explanation to 28 words or fewer while preserving all citation references in the form [1], [2], etc. ` +
      `Do not introduce new citations. Do not change the verdict. Do not change which sources are referenced — only the prose length.\n\n` +
      `Your previous explanation:\n"${input.explanation}"`
    );
  }

  if (fuFail && typeof input.follow_up === 'string') {
    const n = input.follow_up.split(/\s+/).filter(Boolean).length;
    parts.push(
      `Your previous follow-up question was ${n} words. The required maximum is 18 words. ` +
      `Shorten the previous follow-up to 18 words or fewer while preserving its meaning.\n\n` +
      `Your previous follow-up:\n"${input.follow_up}"`
    );
  }

  parts.push('Produce the corrected fact_check tool call now.');
  return parts.join('\n\n');
}

export async function runDocket(
  claim: ClaimClassification,
  sources: RetrievedSource[],
  formattedContext: string
): Promise<{ output: DocketOutput | null; ms: number }> {
  const start = Date.now();

  // Empty retrieval: suppress entirely (per spec §3E).
  if (sources.length === 0) {
    console.log('[DOCKET] Suppressed — zero sources.');
    return { output: null, ms: 0 };
  }

  // All-Tier-3 retrieval: nudge toward PARTIAL (no longer forced UNVERIFIABLE).
  // Trust Haiku's judgment per the new VERDICT RULES — citations from related
  // context still count.
  const allTier3 = sources.every((s) => s.tier === 3);

  const userMessage = `${formattedContext}\n\nUse the fact_check tool to respond.${
    allTier3
      ? '\n\nNote: only Tier 3 sources are available. Prefer PARTIAL over TRUE/FALSE when source quality is borderline.'
      : ''
  }`;

  let parsed: DocketOutput | null = null;
  let correctiveInstruction: string | null = null;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    const attemptUserMessage = correctiveInstruction
      ? `${userMessage}\n\n${correctiveInstruction}`
      : userMessage;
    let raw: any;
    try {
      raw = await callHaiku({
        systemPrompt: DOCKET_SYSTEM,
        userMessage: attemptUserMessage,
        maxTokens: 400,
        temperature: 0,
        tools: [FACT_CHECK_TOOL],
        toolChoice: { type: 'tool', name: 'fact_check' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[DOCKET] Haiku call failed (attempt ${attempt}): ${msg}`);
      continue;
    }

    const input = extractToolUseInput(raw);
    if (!input) {
      console.warn(`[DOCKET] no fact_check tool_use in response (attempt ${attempt})`);
      continue;
    }

    const zParse = DocketSchema.safeParse(input);
    if (!zParse.success) {
      const messages = zParse.error.issues.map((i) => i.message);
      console.warn(`[DOCKET] Zod validation failed (attempt ${attempt}): ${messages.join('; ')}`);

      // Capture word-count failures for corrective retry on attempt 2.
      // Only fires on attempt 1 — attempt 2 falls through to suppression if it fails again.
      if (attempt === 1) {
        const explFail = messages.find((m) => m.startsWith('Explanation exceeds'));
        const fuFail = messages.find((m) => m.startsWith('Follow-up exceeds'));
        if (explFail || fuFail) {
          correctiveInstruction = buildCorrectiveInstruction(input, explFail, fuFail);
        }
      }
      continue;
    }
    let candidate: DocketOutput = zParse.data;

    // Anti-pattern scan on explanation + follow_up. Retry once on hit.
    // Carve-out: under PARTIAL, "appears" and "suggests" are allowed because
    // the model needs them to describe what a source partially establishes.
    const activeList = candidate.verdict === 'PARTIAL'
      ? DOCKET_ANTI_PATTERNS.filter((p) => !DOCKET_PARTIAL_ALLOWED.has(p))
      : DOCKET_ANTI_PATTERNS;
    const hits = [
      ...scanAntiPatterns(candidate.explanation, activeList),
      ...scanAntiPatterns(candidate.follow_up, activeList),
    ];
    if (hits.length > 0) {
      console.log(`[DOCKET] Anti-pattern detected: ${hits.join(', ')} verdict=${candidate.verdict} (attempt ${attempt})`);
      continue;
    }

    // Citation cross-check: every [N] in the explanation must have a citation
    // entry in the citations array. Strip dangling refs.
    const refs = citationsRefInExplanation(candidate.explanation);
    if (refs.length > candidate.citations.length) {
      let cleaned = candidate.explanation;
      for (const n of refs) {
        if (n > candidate.citations.length) {
          cleaned = cleaned.replace(new RegExp(`\\s*\\[${n}\\]`, 'g'), '');
        }
      }
      candidate = { ...candidate, explanation: cleaned.trim() };
    }

    // URL cross-check: every cited URL must be in the retrieved sources.
    // Strip hallucinated URLs. null-URL citations are LanceDB archive
    // references (no public URL) — pass them through.
    const validUrls = new Set(sources.map((s) => s.url).filter((u): u is string => !!u));
    const surviving = candidate.citations.filter(
      (c) => c.url === null || validUrls.has(c.url)
    );
    if (surviving.length !== candidate.citations.length) {
      const dropped = candidate.citations.length - surviving.length;
      console.warn(`[DOCKET] Stripped ${dropped} hallucinated citation URL(s)`);
      candidate = { ...candidate, citations: surviving };
      if (surviving.length === 0 && candidate.verdict !== 'UNVERIFIABLE') {
        candidate = {
          ...candidate,
          verdict: 'UNVERIFIABLE',
          explanation: 'No primary source located in show archive or live retrieval.',
        };
      }
    }

    // Tag Haiku-emitted citations with provenance. The post-processor
    // injection below tags its citations 'post_processor'.
    candidate = {
      ...candidate,
      citations: candidate.citations.map((c) => ({
        ...c,
        citationSource: 'haiku' as const,
      })),
    };

    candidate = applyLanceDBInjection(candidate, sources, claim);

    // UNVERIFIABLE: trust Haiku's judgment. If sources existed and Haiku still
    // returned UNVERIFIABLE with empty citations after injection guards
    // declined to add one, log it.
    if (candidate.verdict === 'UNVERIFIABLE' && candidate.citations.length === 0) {
      console.warn('[DOCKET] UNVERIFIABLE with empty citations despite non-empty retrieval');
    }

    // Citation source breakdown — tuning metric, not rendered.
    const haikuCount = candidate.citations.filter((c) => c.citationSource === 'haiku').length;
    const postCount = candidate.citations.filter((c) => c.citationSource === 'post_processor').length;
    console.log(`[DOCKET] Citation source breakdown: haiku=${haikuCount} post_processor=${postCount}`);

    parsed = candidate;
  }

  return { output: parsed, ms: Date.now() - start };
}

// ─── 4. The Pattern Recognizer ─────────────────────────────────────────

function extractText(response: any): string {
  const blocks = response?.content;
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out.trim();
}

export function truncateToWordLimit(text: string, maxWords: number): { text: string; truncated: boolean; from: number; to: number } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { text, truncated: false, from: words.length, to: words.length };
  // Try to end on a sentence boundary that fits.
  const sentences = text.split(/(?<=[.!?])\s+/);
  let acc = '';
  let accWords = 0;
  for (const s of sentences) {
    const sw = s.split(/\s+/).filter(Boolean).length;
    if (accWords + sw > maxWords) break;
    acc += (acc ? ' ' : '') + s;
    accWords += sw;
  }
  if (acc.trim().length === 0) {
    // No complete sentence fits — hard cut at word boundary.
    acc = words.slice(0, maxWords).join(' ');
    accWords = maxWords;
  }
  return { text: acc.trim(), truncated: true, from: words.length, to: accWords };
}

export async function runPattern(
  claim: ClaimClassification,
  formattedContext: string,
  hasSources: boolean
): Promise<{ output: PatternOutput | null; ms: number }> {
  const start = Date.now();

  const userMessage = hasSources
    ? formattedContext
    : `${formattedContext}\n\nNo retrieval sources were available — reason from general knowledge only and clearly flag uncertainty.`;

  let parsed: PatternOutput | null = null;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    let raw: any;
    try {
      raw = await callHaiku({
        systemPrompt: PATTERN_SYSTEM,
        userMessage,
        maxTokens: 200,
        temperature: 0.3,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PATTERN] Haiku call failed (attempt ${attempt}): ${msg}`);
      continue;
    }

    const text = extractText(raw);
    if (!text) {
      console.warn(`[PATTERN] empty response (attempt ${attempt})`);
      continue;
    }

    // Word-count cap with sentence-aware truncation (don't suppress, just trim).
    const t = truncateToWordLimit(text, PATTERN_WORD_LIMITS.hardMax);
    if (t.truncated) console.log(`[PATTERN] Truncated from ${t.from} to ${t.to} words.`);

    // Anti-pattern scan: corrective opener (retry) and content blocklist (retry).
    const firstWord = t.text.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
    const correctiveOpener = PATTERN_CORRECTIVE_OPENERS.includes(firstWord);
    const contentHits = scanAntiPatterns(t.text, PATTERN_ANTI_PATTERNS);
    if (correctiveOpener) {
      console.log(`[PATTERN] Corrective opener "${firstWord}" — retrying (attempt ${attempt})`);
      continue;
    }
    if (contentHits.length > 0) {
      console.log(`[PATTERN] Anti-pattern detected: ${contentHits.join(', ')} (attempt ${attempt})`);
      continue;
    }

    // Multi-sentence warning (don't suppress).
    const sentenceCount = (t.text.match(/(?<=[.!?])\s+[A-Z]/g) || []).length + 1;
    if (sentenceCount > 2) {
      console.warn(`[PATTERN] ${sentenceCount} sentences detected (target ≤2)`);
    }

    const zParse = PatternSchema.safeParse({ text: t.text });
    if (!zParse.success) {
      console.warn(`[PATTERN] Zod validation failed (attempt ${attempt})`);
      continue;
    }
    parsed = { text: zParse.data.text };
  }

  return { output: parsed, ms: Date.now() - start };
}

// ─── 5. Host Contradiction (DISABLED at this layer) ────────────────────

let contradictionDisabledLogged = false;

export async function checkHostContradiction(
  _claim: ClaimClassification,
  _recentSegments: TranscriptSegment[]
): Promise<{ output: HostContradictionOutput | null; ms: number }> {
  // EpisodeChunk does not carry a per-chunk speaker field — chunks are
  // mixed-speaker conversation slices. The spec gates this feature on
  // chunk-level speaker metadata, so we skip and log once.
  if (!contradictionDisabledLogged) {
    console.log('[CONTRADICTION] Speaker metadata not available in LanceDB — feature disabled');
    contradictionDisabledLogged = true;
  }
  return { output: null, ms: 0 };
}

// ─── synthesize() ──────────────────────────────────────────────────────

export async function synthesize(
  claim: ClaimClassification,
  sources: RetrievedSource[],
  recentSegments: TranscriptSegment[],
  sessionContext: SessionContext = {}
): Promise<SynthesisResult> {
  const tStart = Date.now();
  console.log(`[classifier-pass] claimId=${claim.segmentId} claimType=${claim.claimType} primaryEntity="${claim.primaryEntity}"`);
  const docketContext = formatForDocket(sources, claim, recentSegments, sessionContext);
  const patternContext = formatForPattern(sources, claim, recentSegments, sessionContext);

  // Host contradiction runs first — a fired contradiction suppresses Pattern.
  // Currently always returns null (feature disabled), so Pattern always runs.
  const contradictionPromise = checkHostContradiction(claim, recentSegments);
  const { output: contradictionOutput, ms: contradictionMs } = await contradictionPromise;

  const suppressPattern = contradictionOutput !== null;

  const docketP = runDocket(claim, sources, docketContext);
  const patternP = suppressPattern
    ? Promise.resolve({ output: null as PatternOutput | null, ms: 0 })
    : runPattern(claim, patternContext, sources.length > 0);

  const [docketRes, patternRes] = await Promise.all([docketP, patternP]);

  const patternFired = patternRes.output !== null;
  const patternFireReason: 'emit' | 'null' | 'suppressed_by_contradiction' =
    patternFired ? 'emit' : suppressPattern ? 'suppressed_by_contradiction' : 'null';
  console.log(`[pattern-fire] claimId=${claim.segmentId} fired=${patternFired} reason=${patternFireReason}`);

  return {
    docket: docketRes.output,
    pattern: patternRes.output,
    hostContradiction: contradictionOutput,
    timing: {
      docketMs: docketRes.ms,
      patternMs: patternRes.ms,
      contradictionMs,
      totalMs: Date.now() - tStart,
    },
  };
}
