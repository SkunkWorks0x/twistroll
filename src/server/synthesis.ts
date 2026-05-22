// Sentinel synthesis layer — Stage 2 of the two-stage pipeline.
//
// One Haiku call per claim:
//   - Docket  (tool_use, deterministic, 5-verdict fact-check + citations)
//
// Conventions reused from elsewhere in the codebase: raw fetch for the
// Anthropic Messages API (matches llm-router.ts; the project does not currently
// depend on @anthropic-ai/sdk and the claude-api skill prohibits mixing raw
// fetch + SDK inside one codebase). Prompt caching is applied to the static
// system prompt + tool def via cache_control: { type: 'ephemeral' } so
// repeated claims hit the cache rather than re-billing the few-shot block on
// every fire.

import { z } from 'zod';
import type { ClaimClassification, TranscriptSegment } from '../shared/types.js';
import type { RetrievedSource } from './retrieval.js';
import { formatForDocket } from './retrieval.js';
import {
  getPersonaFragment,
  getCurrentMode,
  getExplanationWordMax,
  type PersonaFragment,
} from './personaModes.js';

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
  // ≤150-char excerpt from the matched RetrievedSource — passthrough only.
  snippet?: string;
}

export interface DocketOutput {
  grounding: string;
  verdict: 'TRUE' | 'FALSE' | 'MISLEADING' | 'PARTIAL' | 'UNVERIFIABLE';
  explanation: string;
  citations: DocketCitation[];
}

export interface SynthesisResult {
  docket: DocketOutput | null;
  timing: {
    docketMs: number;
    totalMs: number;
  };
}

// ─── Zod schemas ───────────────────────────────────────────────────────

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

// Schema is built per request so the explanation word max can be tuned at
// runtime via the Customize panel (see personaModes.ts).
function buildDocketSchema(explanationWordMax: number) {
  return z.object({
    grounding: z.string().refine((s) => wordCount(s) <= 40, 'Grounding exceeds 40 words'),
    verdict: z.enum(['TRUE', 'FALSE', 'MISLEADING', 'PARTIAL', 'UNVERIFIABLE']),
    explanation: z.string().refine(
      (s) => wordCount(s) <= explanationWordMax,
      `Explanation exceeds ${explanationWordMax} words`,
    ),
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
  });
}

const CANONICAL_UNVERIFIABLE_PHRASE = 'No primary source located in show archive or live retrieval.';
const LANCEDB_INJECTION_SCORE_FLOOR = 0.45;

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

function scanBlocklist(text: string, list: string[]): string[] {
  const lower = text.toLowerCase();
  return list.filter((p) => {
    const pat = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return pat.test(lower);
  });
}

// ─── Tool definition for Docket ────────────────────────────────────────

function buildFactCheckTool(explanationWordMax: number) {
  const targetHigh = Math.max(12, explanationWordMax - 4);
  const targetLow = Math.max(8, targetHigh - 4);
  return {
    name: 'fact_check',
    description: 'Output a structured fact-check verdict for the current claim.',
    input_schema: {
      type: 'object',
      properties: {
        grounding: {
          type: 'string',
          description: "One sentence stating what the retrieved evidence directly says about the claim's specific assertion. Must reference at least one source. If evidence does not address the assertion, say so explicitly.",
        },
        verdict: {
          type: 'string',
          enum: ['TRUE', 'FALSE', 'MISLEADING', 'PARTIAL', 'UNVERIFIABLE'],
        },
        explanation: {
          type: 'string',
          description: `${targetLow}–${targetHigh} words target, ${explanationWordMax} hard max. Include [1][2] citation references.`,
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
      },
      required: ['grounding', 'verdict', 'explanation', 'citations'],
    },
  };
}

// ─── System prompts ────────────────────────────────────────────────────

// Built per request so the persona fragment (voice, grounding addendum,
// verdict addendum) and the explanation word max can be tuned at runtime.
// For mode=producer with default wordMax=28, this reproduces the May 2026
// DOCKET_SYSTEM byte-for-byte.
function buildDocketSystem(fragment: PersonaFragment, explanationWordMax: number): string {
  const groundingExtra = fragment.groundingInstructions
    ? `\n\n${fragment.groundingInstructions}`
    : '';
  const verdictExtra = fragment.verdictGuidance
    ? `\n\n${fragment.verdictGuidance}`
    : '';
  return `You are The Docket — a real-time fact-checker for a live podcast interview.
${fragment.explanationVoice}
RULES:
* You verify claims using ONLY the sources provided. Never invent sources.
* Treat host AND co-host statements with identical rigor to guest statements.
* Never use under TRUE / FALSE / UNVERIFIABLE: "likely", "probably", "concerning", "important", "notable", "exciting"
* "appears" and "suggests" are reserved for PARTIAL explanations only — to describe what a source partially establishes
* Never use precedent/pattern language: "history shows", "similar to", "we saw with", "this matches"
* Never editorialize: "worth noting", "red flag", "good question"
* Never reference "cynic" or implication/risk framing
* Grounding must be 40 words or fewer. Count carefully.
* Explanation must be ${explanationWordMax} words or fewer. Count carefully.
* Every citation number [1], [2] must correspond to a source in the provided list. Never fabricate.

GROUNDING:

Before assigning a verdict, populate the grounding field: state in one sentence what the retrieved evidence directly says about the specific assertion in the claim. Do not restate the claim. Do not summarize the topic. If the evidence does not directly address the assertion, say so explicitly and assign UNVERIFIABLE. The grounding must reference at least one citation by number.${groundingExtra}

SOURCE SECTIONS:

The retrieval context is split into two sections.

PRIMARY EVIDENCE (use to determine verdict) — transcripts, SEC filings, news articles, prior TWiST archive episodes. These are load-bearing facts. Citations from this section can support any verdict.

SECONDARY SHOW MEMORY (prior Sentinel conclusions — context only, not primary evidence) — derived verdicts emitted by Sentinel on past claims. Treat these as background context only. NEVER cite them as the sole basis for a TRUE, FALSE, or MISLEADING verdict. If the only sources that address the assertion live in SECONDARY SHOW MEMORY, the correct verdict is UNVERIFIABLE.

VERDICT RULES:

TRUE — A retrieved source directly confirms the specific claim (number, date, name, fact). Cite the source.

FALSE — A retrieved source directly contradicts the specific claim. Cite the source showing the correct information.

MISLEADING — The claim is technically defensible but the framing distorts context. Sources show why. Cite them.

PARTIAL — Retrieved sources establish surrounding context, related figures, or domain consensus, but do NOT confirm the exact number, date, or attribution in the claim. THIS IS THE MOST COMMON VERDICT. Cite what the sources DO confirm. State explicitly what remains unverified. The citation is a contextual receipt, not a verdict warrant.

PARTIAL — PRODUCT / PLATFORM / HEADCOUNT CLAIMS:
For claims about product availability ("X is live in App Store"), platform reach ("N users / N developers / launched in N countries"), or headcount-style figures, a Tier 2 source covering the SAME entity in the claim is sufficient for PARTIAL with citation. Examples: an official company landing page, CB Insights / Crunchbase / PitchBook profile, established tech press (TechCrunch, Reuters, Bloomberg, The Information). Cite the source even if it doesn't confirm the exact number — it confirms the entity exists and is operating in the space the claim describes.

UNVERIFIABLE — No retrieved source addresses the entity in the claim at all. This verdict is reserved for genuine retrieval failure — not for "I found a source about the entity but it doesn't confirm the exact stat." If at least one merged source names or covers the entity in the claim, use PARTIAL instead. Sources about a different entity that happens to share the claim's number (e.g., "$280M valuation" matched against an unrelated company's $280M raise) do NOT count as topical — those still warrant UNVERIFIABLE.

When in doubt between PARTIAL and UNVERIFIABLE: if you can write a meaningful explanation that references at least one source, it's PARTIAL. If you genuinely have nothing to work with, it's UNVERIFIABLE.${verdictExtra}

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
  "grounding": "Q1 2026 investor deck [1] reports $12M ARR and 85% net revenue retention for the latest quarter.",
  "verdict": "TRUE",
  "explanation": "ARR of $12M with 85% net revenue retention for the latest quarter is stated in the Q1 2026 investor deck [1].",
  "citations": [{"title": "Q1 2026 Investor Deck", "url": "https://investors.example.com/deck-q1-2026", "tier": 1}]
}

Example 2 — TRUE (Jason self-reference)
CLAIM: "As I said on the last episode, this founder's prior company was acquired by Microsoft for $800M."
OUTPUT:
{
  "grounding": "March 2025 SEC 8-K filing [1] confirms Microsoft's $800M acquisition of the founder's prior company.",
  "verdict": "TRUE",
  "explanation": "The $800M acquisition of the founder's prior company by Microsoft is confirmed in the March 2025 SEC filing [1].",
  "citations": [{"title": "Microsoft 8-K Filing – March 2025", "url": "https://www.sec.gov/Archives/edgar/data/789019/000119312525012345/d12345d8k.htm", "tier": 1}]
}

Example 3 — FALSE (overstating metric)
CLAIM: "Our annual churn is under 3%, which is best in class for this stage."
OUTPUT:
{
  "grounding": "Form 10-K Fiscal Year 2025 [1] reports annual churn at 9%, contradicting the stated under-3% figure.",
  "verdict": "FALSE",
  "explanation": "Public customer disclosures show annual churn at 9% for the most recent fiscal year, not under 3% [1].",
  "citations": [{"title": "Form 10-K – Fiscal Year 2025", "url": "https://www.sec.gov/Archives/edgar/data/1234567/0001234567250000123/annualreport.htm", "tier": 1}]
}

Example 4 — FALSE (misnaming person/company)
CLAIM: "Our lead investor is Marc Andreessen and the board chair is from Sequoia."
OUTPUT:
{
  "grounding": "Cap table summary [1] lists Benchmark as lead investor; Marc Andreessen is not present on the cap table.",
  "verdict": "FALSE",
  "explanation": "Marc Andreessen is not an investor or board member; the lead is Benchmark per the cap table [1].",
  "citations": [{"title": "Cap Table Summary – Series B", "url": "https://www.crunchbase.com/organization/example-company", "tier": 2}]
}

Example 5 — MISLEADING (cherry-picked)
CLAIM: "We grew revenue 250% year over year while keeping headcount flat."
OUTPUT:
{
  "grounding": "Q4 2025 earnings call [1] and acquisition 8-K [2] confirm the 250% growth excludes a recent acquisition that also added headcount.",
  "verdict": "MISLEADING",
  "explanation": "The 250% revenue growth excludes contribution from the recent acquisition which also added headcount [1][2].",
  "citations": [{"title": "Q4 2025 Earnings Call Transcript", "url": "https://investors.example.com/transcripts/q4-2025", "tier": 1}, {"title": "Acquisition 8-K Filing", "url": "https://www.sec.gov/Archives/edgar/data/1234567/0001234567250000456/8k.htm", "tier": 1}]
}

Example 6 — MISLEADING (context-dependent)
CLAIM: "Our CAC payback period is 4 months, which is exceptional for enterprise software."
OUTPUT:
{
  "grounding": "Internal metrics review [1] shows fully-loaded CAC payback at 11 months when sales team costs are included, not 4 months.",
  "verdict": "MISLEADING",
  "explanation": "The 4-month payback uses only paid acquisition spend; fully loaded CAC including sales team costs extends it to 11 months [1].",
  "citations": [{"title": "Internal Metrics Review – Q4 2025", "url": "https://example.com/metrics-q4", "tier": 2}]
}

Example 7 — PARTIAL (compound claim)
CLAIM: "The product is SOC 2 compliant and we have 40 enterprise customers including two Fortune 500 companies."
OUTPUT:
{
  "grounding": "SOC 2 attestation [1] confirms compliance; public customer disclosures [2] show 40 enterprise customers but none on the Fortune 500.",
  "verdict": "PARTIAL",
  "explanation": "SOC 2 compliance is confirmed [1]; customer count is accurate but neither is a Fortune 500 company per public records [2].",
  "citations": [{"title": "SOC 2 Attestation Report", "url": "https://example.com/compliance", "tier": 2}, {"title": "Public Customer Disclosures", "url": "https://example.com/customers", "tier": 2}]
}

Example 8 — PARTIAL (attribution error)
CLAIM: "Jason mentioned last week that this is the fastest growing vertical SaaS company in the portfolio."
OUTPUT:
{
  "grounding": "TWiST Episode 2270 show notes [1] confirm portfolio membership; April 2026 portfolio update [2] names a different company as fastest-growing.",
  "verdict": "PARTIAL",
  "explanation": "The guest company is in the TWiST portfolio [1]; the fastest-growing designation belongs to a different company in the same cohort [2].",
  "citations": [{"title": "TWiST Episode 2270 Show Notes", "url": "https://twistartups.com/episodes/2270", "tier": 1}, {"title": "Portfolio Performance Update – April 2026", "url": "https://twistartups.com/portfolio", "tier": 1}]
}

Example 9 — UNVERIFIABLE
CLAIM: "This feature set puts us in a category of one with no direct competitors on the horizon."
OUTPUT:
{
  "grounding": "No retrieved source addresses the 'category of one' benchmark or competitor-horizon claim.",
  "verdict": "UNVERIFIABLE",
  "explanation": "No primary source located in show archive or live retrieval for \\"category of one\\" benchmark.",
  "citations": []
}

Example 10 — UNVERIFIABLE
CLAIM: "Our AI model outperforms every other solution on the market by at least 15% on standard benchmarks."
OUTPUT:
{
  "grounding": "No retrieved source addresses the 15% benchmark outperformance claim across competitor models.",
  "verdict": "UNVERIFIABLE",
  "explanation": "No primary source located in show archive or live retrieval for the 15% outperformance benchmark across all competitors.",
  "citations": []
}

Example 11 — PARTIAL (contextual citation, market stat)
CLAIM: "Five US firms captured 73.1% of LP commits in 2024."
OUTPUT:
{
  "grounding": "Reuters [1] and SEC ADV filings [2] confirm record LP concentration in mega-funds but neither cites the specific 73.1% figure.",
  "verdict": "PARTIAL",
  "explanation": "Sources confirm record LP concentration in mega-funds [1][2]; the specific 73.1% figure traces to PitchBook NVCA Venture Monitor, not in retrieval.",
  "citations": [{"title": "Reuters – LP Concentration in US Venture", "url": "https://www.reuters.com/business/finance/lp-concentration-venture-2024", "tier": 1}, {"title": "SEC – Top Fund Form ADV Filings", "url": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany", "tier": 1}]
}

Example 12 — PARTIAL (LanceDB show archive hit)
CLAIM: "This founder previously raised a $50M Series A from Andreessen Horowitz."
OUTPUT:
{
  "grounding": "TWiST Ep 2215 [1] discusses the founder's Series A but does not confirm the $50M figure or Andreessen Horowitz as lead.",
  "verdict": "PARTIAL",
  "explanation": "TWiST Ep 2215 discussed this founder's Series A [1]; round size and lead investor not confirmed in available sources.",
  "citations": [{"title": "TWiST Ep 2215 (March 2026) – Founder Interview", "url": null, "tier": 1}]
}

Example 13 — PARTIAL (funding round, web + LanceDB)
CLAIM: "We closed our Series B at a $280 million valuation led by Benchmark."
OUTPUT:
{
  "grounding": "TechCrunch [1] confirms Benchmark as Series B lead; Crunchbase [2] reports the round but does not state the $280M valuation.",
  "verdict": "PARTIAL",
  "explanation": "TechCrunch confirms Series B close with Benchmark as lead [1]; the $280M valuation is not in the public reporting [2].",
  "citations": [{"title": "TechCrunch – Series B Announcement", "url": "https://techcrunch.com/2026/03/example-series-b", "tier": 1}, {"title": "Crunchbase – Company Funding History", "url": "https://www.crunchbase.com/organization/example-company", "tier": 2}]
}

Example 14 — PARTIAL (platform-statistic claim with company-page evidence)
CLAIM: "Three million developers are already using AcmeCloud."
OUTPUT:
{
  "grounding": "AcmeCloud's company page [1] confirms a multi-million developer base but does not state the specific 3M figure.",
  "verdict": "PARTIAL",
  "explanation": "AcmeCloud's company page confirms a multi-million developer base; the specific 3M figure is not stated in retrieved sources [1].",
  "citations": [{"title": "AcmeCloud – Company Page", "url": "https://acmecloud.example.com", "tier": 2}]
}

Example 15 — PARTIAL (product-availability claim with tech-press evidence)
CLAIM: "Helio is available right now in the App Store and Google Play."
OUTPUT:
{
  "grounding": "TechCrunch [1] covered Helio's launch and positioning but does not confirm specific App Store or Google Play availability.",
  "verdict": "PARTIAL",
  "explanation": "TechCrunch covered Helio's launch and product positioning [1]; specific App Store and Google Play listing status is not confirmed in retrieved sources.",
  "citations": [{"title": "TechCrunch – Helio Launch Coverage", "url": "https://techcrunch.com/2026/example-helio-launch", "tier": 1}]
}

Example 16 — PARTIAL (LanceDB archive only, no web sources)
CLAIM: "There are a billion people using LinkedIn."
OUTPUT:
{
  "grounding": "TWiST Ep 2194 [1] discussed LinkedIn's scale but does not independently confirm the one-billion-user figure.",
  "verdict": "PARTIAL",
  "explanation": "TWiST Ep 2194 discussed LinkedIn's scale and platform reach [1]; the specific one billion figure is not independently confirmed.",
  "citations": [{"title": "TWiST Ep 2194 – LinkedIn platform discussion", "url": null, "tier": 1}]
}`;
}

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
    // Cache the static system prompt block — the Docket prompt is identical
    // across every claim, so cache_control yields ~10x cost reduction on
    // input tokens for hot sessions.
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

// ─── The Docket ────────────────────────────────────────────────────────

function extractToolUseInput(response: any): any | null {
  const blocks = response?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b?.type === 'tool_use' && b?.name === 'fact_check') return b.input;
  }
  return null;
}

// Render-policy predicate. Exported so the unit test in
// scripts/test-render-policy.ts can bind to the same logic the gate uses.
export function isEmptyAbsence(candidate: DocketOutput | null): boolean {
  return !!candidate && candidate.verdict === 'UNVERIFIABLE' && candidate.citations.length === 0;
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
  claim: ClaimClassification,
  explanationWordMax = getExplanationWordMax()
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
  const lanceTrim = (top.content || '').trim();
  const lanceSnippet = !lanceTrim
    ? undefined
    : lanceTrim.length > 150 ? lanceTrim.slice(0, 150).trim() + '…' : lanceTrim;
  let next: DocketOutput = {
    ...candidate,
    citations: [
      ...candidate.citations,
      { title: archiveTitle, url: null, tier: 1, citationSource: 'post_processor' as const, snippet: lanceSnippet },
    ],
  };
  console.log(`[DOCKET] Injected LanceDB archive citation [${injectedIdx}]: Ep ${ep} (score=${top.score.toFixed(4)})`);

  const replacementSentence = `No direct source confirmed; TWiST Ep ${ep} (${date}) covered this topic [${injectedIdx}].`;
  const appendSentence = ` TWiST Ep ${ep} (${date}) covered this topic [${injectedIdx}].`;
  if (next.explanation.includes(CANONICAL_UNVERIFIABLE_PHRASE)) {
    const replaced = next.explanation.replace(CANONICAL_UNVERIFIABLE_PHRASE, replacementSentence);
    next = { ...next, explanation: wordCount(replaced) <= explanationWordMax ? replaced : replacementSentence };
  } else {
    const appended = next.explanation.trimEnd() + appendSentence;
    if (wordCount(appended) <= explanationWordMax) {
      next = { ...next, explanation: appended };
    }
  }

  return next;
}

// URL cross-check guardrail. Strip citations whose URLs aren't in the
// retrieved sources, then renumber surviving inline refs ([1], [2], …)
// against the new citation array. Refs that pointed to dropped citations
// are removed. If every citation is stripped and the verdict required
// evidence, downgrade to UNVERIFIABLE so the empty-absence render policy
// suppresses the card. Exported for unit testing.
export function stripHallucinatedCitations(
  candidate: DocketOutput,
  validUrls: ReadonlySet<string>
): DocketOutput {
  const survivalMap = new Map<number, number>();
  const surviving: DocketCitation[] = [];
  candidate.citations.forEach((c, idx) => {
    if (c.url === null || validUrls.has(c.url)) {
      survivalMap.set(idx + 1, surviving.length + 1);
      surviving.push(c);
    }
  });

  if (surviving.length === candidate.citations.length) return candidate;

  const dropped = candidate.citations.length - surviving.length;
  console.warn(`[DOCKET] Stripped ${dropped} hallucinated citation URL(s)`);

  if (surviving.length === 0) {
    if (candidate.verdict !== 'UNVERIFIABLE') {
      return {
        ...candidate,
        citations: surviving,
        verdict: 'UNVERIFIABLE',
        explanation: 'No primary source located in show archive or live retrieval.',
      };
    }
    return { ...candidate, citations: surviving };
  }

  const remap = (text: string): string =>
    text
      .replace(/(\s*)\[(\d+)\]/g, (_match, ws: string, n: string) => {
        const newIdx = survivalMap.get(parseInt(n, 10));
        return newIdx === undefined ? '' : `${ws}[${newIdx}]`;
      })
      .trim();

  return {
    ...candidate,
    citations: surviving,
    explanation: remap(candidate.explanation),
    grounding: remap(candidate.grounding),
  };
}

// Build a corrective instruction appended to the user message on retry attempt 2
// when attempt 1 failed Zod validation due to explanation or grounding word
// overflow. Tells Haiku to shorten while preserving citations and verdict.
//
// `input` is the failed attempt's tool_use payload (matches DocketOutput shape
// pre-validation).
export function buildCorrectiveInstruction(
  input: { explanation?: unknown; grounding?: unknown },
  explFail: string | undefined,
  groundingFail: string | undefined,
  explanationWordMax = getExplanationWordMax()
): string {
  const parts: string[] = [];

  if (explFail && typeof input.explanation === 'string') {
    const n = input.explanation.split(/\s+/).filter(Boolean).length;
    parts.push(
      `Your previous explanation was ${n} words. The required maximum is ${explanationWordMax} words. ` +
      `Shorten the previous explanation to ${explanationWordMax} words or fewer while preserving all citation references in the form [1], [2], etc. ` +
      `Do not introduce new citations. Do not change the verdict. Do not change which sources are referenced — only the prose length.\n\n` +
      `Your previous explanation:\n"${input.explanation}"`
    );
  }

  if (groundingFail && typeof input.grounding === 'string') {
    const n = input.grounding.split(/\s+/).filter(Boolean).length;
    parts.push(
      `Your previous grounding was ${n} words. The required maximum is 40 words. ` +
      `Shorten the previous grounding to 40 words or fewer while preserving the citation references.\n\n` +
      `Your previous grounding:\n"${input.grounding}"`
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

  // Snapshot persona + word-max settings once per request so a mid-flight
  // panel change doesn't tear the schema/tool/prompt apart between attempts.
  const personaMode = getCurrentMode();
  const personaFragment = getPersonaFragment(personaMode);
  const explanationWordMax = getExplanationWordMax();
  const docketSystem = buildDocketSystem(personaFragment, explanationWordMax);
  const factCheckTool = buildFactCheckTool(explanationWordMax);
  const docketSchema = buildDocketSchema(explanationWordMax);
  console.log(`[DOCKET] Mode=${personaMode} explanationWordMax=${explanationWordMax}`);

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
        systemPrompt: docketSystem,
        userMessage: attemptUserMessage,
        maxTokens: 500,
        temperature: 0,
        tools: [factCheckTool],
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

    const zParse = docketSchema.safeParse(input);
    if (!zParse.success) {
      const messages = zParse.error.issues.map((i) => i.message);
      console.warn(`[DOCKET] Zod validation failed (attempt ${attempt}): ${messages.join('; ')}`);

      // Capture word-count failures for corrective retry on attempt 2.
      // Only fires on attempt 1 — attempt 2 falls through to suppression if it fails again.
      if (attempt === 1) {
        const explFail = messages.find((m) => m.startsWith('Explanation exceeds'));
        const groundingFail = messages.find((m) => m.startsWith('Grounding exceeds'));
        if (explFail || groundingFail) {
          correctiveInstruction = buildCorrectiveInstruction(input, explFail, groundingFail, explanationWordMax);
        } else {
          // Non-word-count Zod failure (verdict-enum, tier-range, citation-url, etc.).
          // Without a hint, attempt 2 retries identically and fails identically.
          correctiveInstruction =
            `Your previous fact_check input failed schema validation: ${messages.join('; ')}. ` +
            `Retry strictly conforming to the fact_check tool schema.`;
        }
      }
      continue;
    }
    let candidate: DocketOutput = zParse.data;

    // Anti-pattern scan on explanation + grounding. Retry once on hit.
    // Carve-out: under PARTIAL, "appears" and "suggests" are allowed because
    // the model needs them to describe what a source partially establishes.
    const activeList = candidate.verdict === 'PARTIAL'
      ? DOCKET_ANTI_PATTERNS.filter((p) => !DOCKET_PARTIAL_ALLOWED.has(p))
      : DOCKET_ANTI_PATTERNS;
    const hits = [
      ...scanBlocklist(candidate.explanation, activeList),
      ...scanBlocklist(candidate.grounding, activeList),
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
    // Same ref cross-check for grounding — helper is text-agnostic despite its name.
    if (candidate.grounding) {
      const groundingRefs = citationsRefInExplanation(candidate.grounding);
      if (groundingRefs.length > candidate.citations.length) {
        let cleanedG = candidate.grounding;
        for (const n of groundingRefs) {
          if (n > candidate.citations.length) {
            cleanedG = cleanedG.replace(new RegExp(`\\s*\\[${n}\\]`, 'g'), '');
          }
        }
        candidate = { ...candidate, grounding: cleanedG.trim() };
      }
    }

    // URL cross-check: strip hallucinated URLs and renumber surviving refs.
    // null-URL citations are LanceDB archive references — pass through.
    const validUrls = new Set(sources.map((s) => s.url).filter((u): u is string => !!u));
    candidate = stripHallucinatedCitations(candidate, validUrls);

    // Tag Haiku-emitted citations with provenance. The post-processor
    // injection below tags its citations 'post_processor'.
    candidate = {
      ...candidate,
      citations: candidate.citations.map((c) => {
        const match = c.url !== null
          ? sources.find((s) => s.url === c.url)
          : sources.find((s) => s.url === null && s.title === c.title);
        const trimmed = (match?.content || '').trim();
        const snippet = !trimmed
          ? undefined
          : trimmed.length > 150 ? trimmed.slice(0, 150).trim() + '…' : trimmed;
        return { ...c, citationSource: 'haiku' as const, snippet };
      }),
    };

    candidate = applyLanceDBInjection(candidate, sources, claim, explanationWordMax);

    // Provenance downgrade: if every citation references a derived_verdict
    // source (Sentinel's own prior conclusions written back to LanceDB), the
    // model is echoing itself rather than primary evidence. Downgrade to
    // UNVERIFIABLE so secondary show memory never carries a confident verdict
    // on its own. No-op today since the write-back path doesn't exist yet —
    // exists for forward compatibility with the planned write-back feature.
    if (candidate.citations.length > 0 && candidate.verdict !== 'UNVERIFIABLE') {
      const allDerived = candidate.citations.every((c) => {
        const matches =
          c.url !== null
            ? sources.filter((s) => s.url === c.url)
            : sources.filter((s) => s.url === null && s.title === c.title);
        // Conservative: if ANY matching source is primary, don't count this
        // citation as all-derived. Avoids title-collision false positives
        // where two LanceDB chunks (different episodes) share an exact title.
        if (matches.length === 0) return false;
        return matches.every((s) => s.sourceKind === 'derived_verdict');
      });
      if (allDerived) {
        console.log(`[DOCKET] Downgrade ${candidate.verdict} → UNVERIFIABLE: all citations reference derived_verdict sources`);
        candidate = {
          ...candidate,
          verdict: 'UNVERIFIABLE',
          explanation: 'No primary source located in show archive or live retrieval.',
        };
      }
    }

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

    const citePayload = candidate.citations
      .map((c) => {
        const url = c.url === null ? 'null' : (c.url.length > 200 ? c.url.slice(0, 200) + '...' : c.url);
        return `${url}|${c.tier}|${c.citationSource ?? 'unknown'}`;
      })
      .join(', ');
    console.log(`[DOCKET] Citations: claimId=${claim.segmentId} count=${candidate.citations.length} urls=[${citePayload}]`);

    parsed = candidate;
  }

  // UNVERIFIABLE render policy: suppress empty-absence cards before broadcast.
  // A UNVERIFIABLE verdict with zero citations carries no actionable signal
  // for the host — we found nothing relevant. UNVERIFIABLE WITH citations is
  // "useful absence" (we surfaced related context that doesn't confirm the
  // specific claim) and renders normally. server/index.ts treats output=null
  // as a suppressed card via the existing no-verdict gate.
  if (isEmptyAbsence(parsed)) {
    console.log(`[RENDER-POLICY] Suppressed empty-absence UNVERIFIABLE for entity="${claim.primaryEntity}"`);
    parsed = null;
  }

  return { output: parsed, ms: Date.now() - start };
}

// ─── synthesize() ──────────────────────────────────────────────────────

export async function synthesize(
  claim: ClaimClassification,
  sources: RetrievedSource[],
  recentSegments: TranscriptSegment[]
): Promise<SynthesisResult> {
  const tStart = Date.now();
  console.log(`[classifier-pass] claimId=${claim.segmentId} claimType=${claim.claimType} primaryEntity="${claim.primaryEntity}"`);
  const docketContext = formatForDocket(sources, claim, recentSegments);

  const { output: docketOutput, ms: docketMs } = await runDocket(claim, sources, docketContext);

  return {
    docket: docketOutput,
    timing: {
      docketMs,
      totalMs: Date.now() - tStart,
    },
  };
}
