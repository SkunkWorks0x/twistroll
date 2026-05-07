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
import type { ClaimClassification, TranscriptSegment } from '../shared/types.js';
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
    })
  ),
  follow_up: z.string().refine((s) => wordCount(s) <= 18, 'Follow-up exceeds 18 words'),
});

const PatternSchema = z.object({
  text: z.string().refine((s) => wordCount(s) <= 38, 'Pattern output exceeds 38 words'),
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
* Treat host statements with identical rigor to guest statements.
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

UNVERIFIABLE — No retrieved source is even adjacent to the claim's domain or topic. This verdict is reserved for genuine retrieval failure — not for "I found related sources but they don't confirm the exact stat." If you received ANY topically relevant source, use PARTIAL instead.

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
}`;

const PATTERN_SYSTEM = `You are The Pattern Recognizer — a calm, experienced senior partner providing real-time counterargument during a live podcast interview.
VOICE: "The precedent here is..." Precedent-driven, evidence-grounded. Low-affect, curious, slightly weary but never nihilistic. You sound like a senior partner leaning over during a board meeting murmuring a concern.
RULES:
* One counterpoint only. No lists, no "also...", no multiple sentences with period + capital.
* 28-34 words target, 38 hard max. Count carefully.
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
OUTPUT: The precedent here is vertical SaaS companies sustaining triple-digit growth past $20M ARR without margin expansion. That path usually forces a choice between valuation compression or a much larger next round than planned.

Example 2
CLAIM: "Our proprietary data moat from five years of customer signals is impossible for anyone to copy."
OUTPUT: Market history at this scale shows data moats in SaaS erode within 18-24 months once reverse-engineered by funded competitors. The pressure point is whether defensibility cost stays below the value created.

Example 3
CLAIM: "We're burning $3M a month but the LTV to CAC ratio is 5x so we're fine."
OUTPUT: Unit economics at this velocity typically break when burn exceeds 40% of forward revenue and the next cohort shows lower conversion. The question is whether the 5x LTV/CAC holds when sales cycles lengthen past 90 days.

Example 4
CLAIM: "Every law firm will have our AI assistant inside their workflow within three years."
OUTPUT: The pattern we've seen across vertical AI tools is that 80%+ workflow penetration claims at Series B rarely survive contact with actual procurement cycles and incumbent integration costs. The pressure point is whether the three-year timeline assumes zero switching friction.

Example 5
CLAIM: "We're the only company combining real-time transcription with automated follow-up intelligence for this exact workflow."
OUTPUT: Smart capital would flag that "only company" claims in workflow automation rarely survive first contact with a funded competitor. The pressure point is how long the differentiation window stays open before parity arrives.

Example 6
CLAIM: "Our expansion revenue from existing customers will more than offset any new logo slowdown this year."
OUTPUT: The precedent here is SaaS companies relying on net retention above 120% to mask new logo weakness usually face a cliff when the base saturates. The pressure point is what happens if net retention drops 10 points.

Example 7
CLAIM: "We can maintain 40%+ gross margins while scaling to $100M ARR because our AI stack is so efficient."
OUTPUT: Market history at this scale shows vertical SaaS companies promising 40%+ gross margins at $100M ARR usually see compression once support and model costs scale. The pressure point is whether efficiency survives real customer volume.`;

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
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    let raw: any;
    try {
      raw = await callHaiku({
        systemPrompt: DOCKET_SYSTEM,
        userMessage,
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
      console.warn(`[DOCKET] Zod validation failed (attempt ${attempt}): ${zParse.error.issues.map((i) => i.message).join('; ')}`);
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

    // LanceDB CITATION MANDATE enforcement (post-processor).
    // If any LanceDB source reached Haiku and the model didn't include an
    // archive citation, inject the top-scoring LanceDB hit. The MANDATE in
    // the system prompt asks for it; this makes it deterministic in case
    // the model ignores the directive. Fires on any verdict — UNVERIFIABLE
    // with archive context is per spec §2E ("Sources exist but Haiku
    // returned UNVERIFIABLE with non-empty citations → ACCEPT").
    const lanceSources = sources.filter((s) => s.type === 'lancedb');
    if (lanceSources.length > 0) {
      const hasArchiveCitation = candidate.citations.some(
        (c) => c.url === null || /^twist ep\b/i.test(c.title)
      );
      if (!hasArchiveCitation) {
        const top = [...lanceSources].sort((a, b) => b.score - a.score)[0];
        const ep = top.metadata.episodeNumber;
        const date = top.metadata.episodeDate;
        const epTitle = top.metadata.episodeTitle || '';
        const archiveTitle = `TWiST Ep ${ep} (${date})${epTitle ? ' – ' + epTitle : ''}`;
        candidate = {
          ...candidate,
          citations: [...candidate.citations, { title: archiveTitle, url: null, tier: 1 }],
        };
        console.log(`[DOCKET] Injected LanceDB archive citation: Ep ${ep}`);
      }
    }

    // UNVERIFIABLE: trust Haiku's judgment. If sources existed and Haiku still
    // returned UNVERIFIABLE with empty citations, that's a deliberate refusal
    // worth flagging but not rewriting. Don't force-clear citations or replace
    // the explanation — those moves were too aggressive on the prior version.
    if (candidate.verdict === 'UNVERIFIABLE' && candidate.citations.length === 0) {
      console.warn('[DOCKET] UNVERIFIABLE with empty citations despite non-empty retrieval');
    }

    // All-Tier-3: no longer forced to UNVERIFIABLE. The user-message rider
    // already nudges Haiku toward PARTIAL on Tier-3-only retrieval; trust the
    // resulting verdict.

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

function truncateToWordLimit(text: string, maxWords: number): { text: string; truncated: boolean; from: number; to: number } {
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
    const t = truncateToWordLimit(text, 38);
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
  recentSegments: TranscriptSegment[]
): Promise<SynthesisResult> {
  const tStart = Date.now();
  const docketContext = formatForDocket(sources, claim, recentSegments);
  const patternContext = formatForPattern(sources, claim, recentSegments);

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
