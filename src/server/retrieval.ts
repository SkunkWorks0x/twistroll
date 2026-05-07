// Sentinel retrieval layer. Three parallel sources (LanceDB, Tavily, xAI/Grokipedia)
// merged into a tier-ranked, token-budgeted list of citations for synthesis.
//
// Patterns reused from elsewhere in the codebase: raw fetch for the xAI call (matches
// llm-router.ts), env-key fallback (GROK_API_KEY → XAI_API_KEY), per-source circuit
// breakers + per-source timeouts so one slow source can't stall the whole pipeline.

import { tavily } from '@tavily/core';
import { queryMemory } from './episodeMemory.js';
import type { ClaimClassification, SessionContext, TranscriptSegment } from '../shared/types.js';

export interface RetrievedSource {
  id: string;
  type: 'lancedb' | 'tavily' | 'grokipedia';
  tier: 1 | 2 | 3 | 4;
  title: string;
  url: string | null;
  content: string;
  score: number;
  metadata: {
    episodeNumber?: number;
    episodeDate?: string;
    episodeTitle?: string;
    guestName?: string;
    speaker?: string;
    domain?: string;
    publishDate?: string;
  };
}

// ─── Tier maps ─────────────────────────────────────────────────────────

const TIER_1_DOMAINS = new Set<string>([
  'sec.gov',
  'bls.gov',
  'fred.stlouisfed.org',
  'nytimes.com',
  'wsj.com',
  'bloomberg.com',
  'techcrunch.com',
  'reuters.com',
  'apnews.com',
]);

const TIER_2_DOMAINS = new Set<string>([
  'crunchbase.com',
  'pitchbook.com',
  'theinformation.com',
  'axios.com',
  'theverge.com',
  'theatlantic.com',
  'hbr.org',
  'harvardbusiness.org',
  'ft.com',
  'economist.com',
  'wired.com',
  // Phase 3C: search-bias domains were added to includeDomains but missed
  // here. NVCA / PitchBook PDFs and the rest are primary venture data sources;
  // classify them Tier 2 so they don't trigger the all-Tier-3 nudge.
  'nvca.org',
  'cbinsights.com',
  'carta.com',
  'saastr.com',
  'arstechnica.com',
]);

// Explicit Tier-4 list. No auto-detection of "SEO farms" — false positives risk
// suppressing real sources. Easy to extend.
const TIER_4_DOMAINS = new Set<string>([
  'reddit.com',
  'old.reddit.com',
  'quora.com',
  'medium.com',
  'tumblr.com',
  'seekingalpha.com',
]);

function classifyDomain(url: string | null): 1 | 2 | 3 | 4 {
  if (!url) return 3;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 3;
  }
  const norm = host.replace(/^www\./, '');

  if (TIER_4_DOMAINS.has(norm) || TIER_4_DOMAINS.has(host)) return 4;
  if (TIER_1_DOMAINS.has(norm) || TIER_1_DOMAINS.has(host)) return 1;
  if (norm.endsWith('.gov')) return 1;
  // IR pages: ir.{company}.com or investors.{company}.com
  if (/^(ir|investors)\./.test(norm)) return 1;

  if (TIER_2_DOMAINS.has(norm) || TIER_2_DOMAINS.has(host)) return 2;
  // Wikipedia subdomains (en.wikipedia.org, es.wikipedia.org, etc.)
  if (norm === 'wikipedia.org' || norm.endsWith('.wikipedia.org')) return 2;

  return 3;
}

// ─── Circuit breaker ───────────────────────────────────────────────────

// One-time module-load notice. The Grokipedia retriever is wired but not
// invoked from retrieve() — see comment at the call site.
console.log('[RETRIEVAL] Grokipedia disabled — consistent timeouts. Re-enable when API latency improves.');

// Tier invariant — every domain we bias the broad Tavily query toward should
// be classifiable as Tier 1 or Tier 2. Catches the regression where a domain
// gets added to includeDomains but missed in TIER_*_DOMAINS (which happened
// in the original Phase 3C and dropped NVCA Q1-2026 Venture Monitor PDFs to
// Tier 3, triggering the all-Tier-3 nudge).
function verifyTierInvariant(): void {
  // Forward-declared TAVILY_TIER1_BIAS — the actual constant is defined later
  // in this file; resolution happens at call time.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  const bias = TAVILY_TIER1_BIAS;
  const uncovered: string[] = [];
  for (const domain of bias) {
    if (TIER_1_DOMAINS.has(domain)) continue;
    if (TIER_2_DOMAINS.has(domain)) continue;
    if (domain.endsWith('.gov')) continue; // classifyDomain handles .gov as Tier 1
    uncovered.push(domain);
  }
  if (uncovered.length > 0) {
    console.warn(`[RETRIEVAL] Tier invariant violation — domains in TAVILY_TIER1_BIAS not classified Tier 1/2: ${uncovered.join(', ')}`);
  } else {
    console.log(`[RETRIEVAL] Tier invariant OK — all ${bias.length} bias domains classified`);
  }
}
// Defer the check one tick so module-load order resolves (TAVILY_TIER1_BIAS
// is declared further down in this file).
setImmediate(verifyTierInvariant);

const FAIL_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

type SourceKey = 'lancedb' | 'tavily' | 'grokipedia';
interface BreakerState {
  failures: number;
  openedAt: number | null;
}
const breakers: Record<SourceKey, BreakerState> = {
  lancedb: { failures: 0, openedAt: null },
  tavily: { failures: 0, openedAt: null },
  grokipedia: { failures: 0, openedAt: null },
};

function isBreakerOpen(source: SourceKey): boolean {
  const b = breakers[source];
  if (b.openedAt === null) return false;
  if (Date.now() - b.openedAt > COOLDOWN_MS) {
    b.openedAt = null;
    b.failures = 0;
    console.log(`[RETRIEVAL] Circuit breaker RESET for ${source} (cooldown elapsed)`);
    return false;
  }
  return true;
}

function recordSuccess(source: SourceKey): void {
  breakers[source].failures = 0;
}

function recordFailure(source: SourceKey): void {
  const b = breakers[source];
  b.failures++;
  if (b.failures >= FAIL_THRESHOLD && b.openedAt === null) {
    b.openedAt = Date.now();
    console.warn(`[RETRIEVAL] Circuit breaker OPEN for ${source} after ${b.failures} failures — disabled for 60s`);
  }
}

export function getBreakerState(): Record<SourceKey, { failures: number; open: boolean }> {
  return {
    lancedb: { failures: breakers.lancedb.failures, open: isBreakerOpen('lancedb') },
    tavily: { failures: breakers.tavily.failures, open: isBreakerOpen('tavily') },
    grokipedia: { failures: breakers.grokipedia.failures, open: isBreakerOpen('grokipedia') },
  };
}

// ─── Timeout helper ────────────────────────────────────────────────────

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          console.warn(`[RETRIEVAL] ${label} timed out at ${ms}ms`);
          reject(new Error(`${label} timed out at ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 3A. LanceDB retriever ─────────────────────────────────────────────

// Tokenize primaryEntity into 4+ char words for the post-filter. Stopwords are
// filtered out by the length cutoff; what remains is the high-signal vocabulary
// the chunk text should overlap on.
function entityTokens(entity: string): string[] {
  return entity
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4);
}

export async function queryLanceDB(claim: ClaimClassification): Promise<RetrievedSource[]> {
  if (isBreakerOpen('lancedb')) return [];

  const queryText = (claim.searchableNoun || claim.primaryEntity || '').trim();
  if (!queryText) return [];

  try {
    const results = await queryMemory(queryText, 5);
    recordSuccess('lancedb');

    // Post-filter relaxed 2026-05-07 to align with the Docket's LANCEDB
    // CITATION RULE — the prompt expects topical hits to flow through and
    // lets Haiku decide relevance. The gap-detection floor (0.35) inside
    // queryMemory already screened for relevance; here we only confirm
    // topical overlap via any 4+ char primaryEntity token. Empty primaryEntity
    // (no tokens to match) falls through.
    const tokens = entityTokens(claim.primaryEntity || '');
    const filtered = results
      .filter((r) => {
        if (tokens.length === 0) return true;
        const textLc = r.text.toLowerCase();
        return tokens.some((tok) => textLc.includes(tok));
      })
      .slice(0, 3);

    return filtered.map((r, i) => ({
      id: `lance_${r.episodeNumber}_${i}_${Date.now()}`,
      type: 'lancedb' as const,
      tier: 1 as const,
      title: `TWiST Ep ${r.episodeNumber} (${r.episodeDate})${r.guestName ? ` — ${r.guestName}` : ''}`,
      url: null,
      content: r.text,
      score: r.score,
      metadata: {
        episodeNumber: r.episodeNumber,
        episodeDate: r.episodeDate,
        episodeTitle: r.episodeTitle,
        guestName: r.guestName,
      },
    }));
  } catch (err) {
    recordFailure('lancedb');
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[RETRIEVAL] lancedb failed: ${msg}`);
    return [];
  }
}

// ─── 3B. Tavily retriever ──────────────────────────────────────────────

// Tier-1 / Tier-2 sources we bias the BROAD query toward via includeDomains.
// Source list expanded 2026-05-07 to cover the publishers most likely to host
// venture/SaaS data points TWiST guests cite (PitchBook, NVCA, Crunchbase,
// CB Insights, Carta, SaaStr) plus general business journalism that the
// prior list missed (FT, Economist, The Information, Ars Technica).
const TAVILY_TIER1_BIAS: string[] = [
  'sec.gov', 'bloomberg.com', 'techcrunch.com', 'reuters.com',
  'pitchbook.com', 'nvca.org', 'cbinsights.com', 'carta.com', 'saastr.com',
  'ft.com', 'economist.com', 'theinformation.com', 'arstechnica.com',
];

const MAX_TAVILY_RESULTS = 6;

// Build a topical query for the BROAD search. The discriminator is composed
// from primaryEntity + entityType + keyNumbers + claim language, not
// claimType alone — the classifier's ClaimType enum is too coarse-grained
// (everything money-related is just 'financial').
function buildTavilyQuery(claim: ClaimClassification): string {
  const entity = (claim.primaryEntity || '').trim();
  const noun = (claim.searchableNoun || entity).trim();
  const numbers = claim.keyNumbers || [];
  const firstNum = numbers[0] || '';
  const numStr = numbers.join(' ');

  const hasMoney = /\$/.test(numStr);
  const hasPercent = /%/.test(numStr);
  const isCompany = claim.entityType === 'company';
  const isPerson = claim.entityType === 'person';

  // Person → biographical / attribution-style query
  if (isPerson) {
    return `${entity} ${noun}`.trim();
  }

  // Funding round detection: dollar amount + claim language hints
  // ("Series X", "valuation", "raised", "led by", etc.)
  const claimBlob = `${claim.claimText} ${noun}`.toLowerCase();
  const looksLikeRound = hasMoney && /\b(series\s+[a-z]\b|valuation|raised|round|seed funding|led by)\b/i.test(claimBlob);
  if (looksLikeRound) {
    return `${entity} series funding ${firstNum} TechCrunch OR Crunchbase`.trim();
  }

  // Company metric: company entity + percentage (CAC, retention, churn, etc.)
  if (isCompany && hasPercent) {
    return `${entity} ${firstNum} earnings OR "investor relations" OR revenue`.trim();
  }

  switch (claim.claimType) {
    case 'financial':
      // Broad market/finance — bias toward primary venture data sources
      return `${entity} ${firstNum} PitchBook OR NVCA OR Crunchbase OR "venture monitor"`.trim();
    case 'prediction':
      return `${entity} forecast OR outlook ${firstNum}`.trim();
    case 'historical':
    case 'attribution':
    case 'comparative':
    default:
      return `${entity} ${noun} ${firstNum}`.trim();
  }
}

export async function queryTavily(claim: ClaimClassification): Promise<RetrievedSource[]> {
  if (isBreakerOpen('tavily')) return [];
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[RETRIEVAL] TAVILY_API_KEY not set — skipping Tavily');
    return [];
  }

  const broadQuery = buildTavilyQuery(claim);
  const numStr = (claim.keyNumbers || []).join(' ').trim();
  const narrowQuery = `${claim.primaryEntity || ''} ${numStr}`.trim();

  if (!broadQuery && !narrowQuery) return [];

  try {
    const client = tavily({ apiKey });

    // Two queries in parallel. Broad: tier-1-biased, basic depth. Narrow:
    // entity + raw numbers, no domain filter, deeper search — let Tavily
    // surface the actual stat-bearing pages. Cost: ~$0.005 extra per claim.
    const [broadResp, narrowResp] = await Promise.all([
      broadQuery
        ? client.search(broadQuery, {
            searchDepth: 'basic',
            maxResults: 5,
            includeDomains: TAVILY_TIER1_BIAS,
          })
        : Promise.resolve({ results: [] as any[] }),
      narrowQuery && narrowQuery !== broadQuery
        ? client.search(narrowQuery, {
            searchDepth: 'advanced',
            maxResults: 5,
          })
        : Promise.resolve({ results: [] as any[] }),
    ]);
    recordSuccess('tavily');

    // Merge by URL, keeping first occurrence's score; drop Tier-4.
    const byUrl = new Map<string, RetrievedSource>();
    for (const r of [...(broadResp.results || []), ...(narrowResp.results || [])]) {
      if (!r?.url) continue;
      const tier = classifyDomain(r.url);
      if (tier === 4) continue;
      if (byUrl.has(r.url)) continue;
      let domain: string | undefined;
      try {
        domain = new URL(r.url).hostname.replace(/^www\./, '');
      } catch {
        domain = undefined;
      }
      byUrl.set(r.url, {
        id: `tavily_${Date.now()}_${byUrl.size}`,
        type: 'tavily',
        tier,
        title: r.title || '(untitled)',
        url: r.url,
        content: r.content || '',
        score: typeof r.score === 'number' ? r.score : 0,
        metadata: {
          domain,
          publishDate: r.publishedDate || undefined,
        },
      });
      if (byUrl.size >= MAX_TAVILY_RESULTS) break;
    }
    return [...byUrl.values()];
  } catch (err) {
    recordFailure('tavily');
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[RETRIEVAL] tavily failed: ${msg}`);
    return [];
  }
}

// ─── 3C. Grokipedia retriever (xAI chat) ───────────────────────────────

const GROKIPEDIA_SYSTEM = "You are a factual reference assistant. Given an entity or claim, provide a brief factual summary with key dates, numbers, and relationships. Be concise. If you don't know, say so.";

export async function queryGrokipedia(claim: ClaimClassification): Promise<RetrievedSource[]> {
  if (isBreakerOpen('grokipedia')) return [];
  // Read GROK_API_KEY first to match existing llm-router convention; fall back
  // to XAI_API_KEY for forward compatibility with the spec wording.
  const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (!apiKey) {
    console.warn('[RETRIEVAL] GROK_API_KEY/XAI_API_KEY not set — skipping Grokipedia');
    return [];
  }

  const entity = (claim.primaryEntity || claim.searchableNoun || '').trim();
  if (!entity) return [];

  const userPrompt = `Provide factual context about: ${entity}. Relevant claim: ${claim.claimText}`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4-1-fast',
        max_tokens: 400,
        messages: [
          { role: 'system', content: GROKIPEDIA_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`xAI HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('grokipedia empty response');

    recordSuccess('grokipedia');
    return [
      {
        id: `grokipedia_${Date.now()}`,
        type: 'grokipedia',
        tier: 2,
        title: `Grokipedia: ${entity}`,
        url: null,
        content: text,
        score: 0.5,
        metadata: {},
      },
    ];
  } catch (err) {
    recordFailure('grokipedia');
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[RETRIEVAL] grokipedia failed: ${msg}`);
    return [];
  }
}

// ─── retrieve(): all three in parallel ─────────────────────────────────

export interface RetrievalResult {
  lance: RetrievedSource[];
  tavily: RetrievedSource[];
  grokipedia: RetrievedSource[];
  merged: RetrievedSource[];
  timing: {
    lancedb: number;
    tavily: number;
    grokipedia: number;
    total: number;
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ data: T; ms: number }> {
  const t = Date.now();
  const data = await fn();
  return { data, ms: Date.now() - t };
}

const TAVILY_TIMEOUT_FIRST_MS = 2500;
const TAVILY_TIMEOUT_RETRY_MS = 3000;

// Tavily retry-once on timeout. First attempt 2500ms; on timeout (only — not
// other errors), retry once at 3000ms. Both fail → empty array. Mirrors the
// retry shape in llm-router.ts's grok path.
async function tavilyWithRetry(claim: ClaimClassification): Promise<RetrievedSource[]> {
  try {
    return await withTimeout(queryTavily(claim), TAVILY_TIMEOUT_FIRST_MS, 'tavily');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/timed out/.test(msg)) {
      // Non-timeout failure — already logged inside queryTavily/withTimeout
      return [];
    }
    console.warn('[RETRIEVAL] tavily timed out — retrying once');
    try {
      return await withTimeout(queryTavily(claim), TAVILY_TIMEOUT_RETRY_MS, 'tavily');
    } catch {
      return [];
    }
  }
}

export async function retrieve(claim: ClaimClassification): Promise<RetrievalResult> {
  const tStart = Date.now();
  const [lr, tr, gr] = await Promise.all([
    timed(() => withTimeout(queryLanceDB(claim), 300, 'lancedb').catch(() => [] as RetrievedSource[])),
    timed(() => tavilyWithRetry(claim)),
    // Grokipedia disabled — 2026-05-07 live test showed 8/8 timeouts at 2500ms
    // against grok-4-1-fast. Function preserved (queryGrokipedia is exported)
    // for re-enable when API latency improves.
    // timed(() => withTimeout(queryGrokipedia(claim), 2500, 'grokipedia').catch(() => [] as RetrievedSource[])),
    timed(async () => [] as RetrievedSource[]),
  ]);
  const timing = {
    lancedb: lr.ms,
    tavily: tr.ms,
    grokipedia: gr.ms,
    total: Date.now() - tStart,
  };
  const merged = mergeAndRank(lr.data, tr.data, gr.data);
  return { lance: lr.data, tavily: tr.data, grokipedia: gr.data, merged, timing };
}

// ─── 4. Merge and rank ─────────────────────────────────────────────────

const TOKEN_BUDGET = 1400;
const MAX_SOURCES = 6;

function estimateTokens(s: RetrievedSource): number {
  return Math.ceil((s.title.length + s.content.length) / 4);
}

export function mergeAndRank(
  lance: RetrievedSource[],
  tavily: RetrievedSource[],
  grokipedia: RetrievedSource[]
): RetrievedSource[] {
  // 1. Combine
  let all: RetrievedSource[] = [...lance, ...tavily, ...grokipedia];

  // 2. Defense-in-depth tier-4 filter
  all = all.filter((s) => s.tier !== 4);

  // 3. Dedupe by URL — keep better tier; tie-break preferring Tavily snippet
  const byUrl = new Map<string, RetrievedSource>();
  const noUrl: RetrievedSource[] = [];
  for (const s of all) {
    if (!s.url) {
      noUrl.push(s);
      continue;
    }
    const existing = byUrl.get(s.url);
    if (!existing) {
      byUrl.set(s.url, s);
      continue;
    }
    if (s.tier < existing.tier) byUrl.set(s.url, s);
    else if (s.tier === existing.tier && s.type === 'tavily' && existing.type !== 'tavily') {
      byUrl.set(s.url, s);
    }
  }

  // 4. LanceDB chunk dedupe by (episodeNumber, first 100 chars)
  const lanceSeen = new Set<string>();
  const lanceKept: RetrievedSource[] = [];
  const others: RetrievedSource[] = [];
  for (const s of [...noUrl, ...byUrl.values()]) {
    if (s.type === 'lancedb') {
      const key = `${s.metadata.episodeNumber ?? '?'}_${s.content.slice(0, 100)}`;
      if (!lanceSeen.has(key)) {
        lanceSeen.add(key);
        lanceKept.push(s);
      }
    } else {
      others.push(s);
    }
  }

  // 5. Sort: tier ASC, score DESC, recency DESC
  function rank(a: RetrievedSource, b: RetrievedSource): number {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.score !== b.score) return b.score - a.score;
    const dA = a.metadata.publishDate || a.metadata.episodeDate || '';
    const dB = b.metadata.publishDate || b.metadata.episodeDate || '';
    return dB.localeCompare(dA);
  }
  const sortedLance = [...lanceKept].sort(rank);
  const sortedOthers = [...others].sort(rank);
  const combined = [...sortedLance, ...sortedOthers].sort(rank);

  // 6. Guarantee top LanceDB hit (the moat)
  const topLance = sortedLance[0];
  let final: RetrievedSource[] = [];
  if (topLance) {
    final.push(topLance);
    for (const s of combined) {
      if (s.id === topLance.id) continue;
      final.push(s);
      if (final.length >= MAX_SOURCES) break;
    }
  } else {
    final = combined.slice(0, MAX_SOURCES);
  }

  // 9. Token budget — drop lowest-ranked while over budget (don't drop the
  // guaranteed top-LanceDB unless it's the only one left).
  let tokens = final.reduce((sum, s) => sum + estimateTokens(s), 0);
  while (final.length > 1 && tokens > TOKEN_BUDGET) {
    const dropped = final.pop()!;
    tokens -= estimateTokens(dropped);
  }

  return final;
}

// ─── 5. Formatters ─────────────────────────────────────────────────────

// Build the "SPEAKER: <role> (<name>)" line, OR bare "SPEAKER: <role>" if no
// real name is available. Empirically, appending a redundant role-word as
// the name (e.g. "SPEAKER: guest (Guest)") shifts Haiku toward UNVERIFIABLE
// on synthesis-layer tests — only attach a name when it's a per-id override
// or a real sessionContext field, not the role-fallback literal.
function formatSpeakerLine(claim: ClaimClassification, ctx: SessionContext): string {
  const role = claim.speaker;
  const tag = role === 'host' ? 'host' : role === 'cohost' ? 'cohost' : 'guest';
  const perId = ctx.speakerNames?.[claim.speakerNumber];
  const fallback = role === 'host' ? ctx.hostName : role === 'cohost' ? ctx.cohostName : ctx.guestName;
  const realName = perId || fallback;
  return realName ? `SPEAKER: ${tag} (${realName})` : `SPEAKER: ${tag}`;
}

export function formatForDocket(
  sources: RetrievedSource[],
  claim: ClaimClassification,
  recentSegments: TranscriptSegment[],
  sessionContext: SessionContext = {}
): string {
  let out = `CLAIM: ${claim.claimText}\n${formatSpeakerLine(claim, sessionContext)}\n\n`;
  out += 'RECENT CONVERSATION (last 8 segments):\n';
  for (const seg of recentSegments.slice(-8)) {
    out += `[${seg.speakerLabel}] "${seg.text}"\n`;
  }
  out += '\nSOURCES:\n';
  if (sources.length === 0) {
    out += '(no sources retrieved)\n';
  } else {
    sources.forEach((s, i) => {
      const url = s.url ?? '(LanceDB)';
      // LanceDB chunks need more excerpt for the topical anchor to surface —
      // 200 chars often cut mid-transcript before any anchor word appeared.
      const limit = s.type === 'lancedb' ? 400 : 200;
      out += `[${i + 1}] ${s.title} | ${url} | Tier ${s.tier}\n`;
      const excerpt = s.content.slice(0, limit);
      out += `Excerpt: "${excerpt}${s.content.length > limit ? '…' : ''}"\n\n`;
    });
  }
  return out;
}

export function formatForPattern(
  sources: RetrievedSource[],
  claim: ClaimClassification,
  recentSegments: TranscriptSegment[],
  sessionContext: SessionContext = {}
): string {
  let out = `CLAIM: ${claim.claimText}\n${formatSpeakerLine(claim, sessionContext)}\n\n`;
  out += 'RECENT CONVERSATION (last 8 segments):\n';
  for (const seg of recentSegments.slice(-8)) {
    out += `[${seg.speakerLabel}] "${seg.text}"\n`;
  }
  out += '\nCONTEXT:\n';
  if (sources.length === 0) {
    out += 'No retrieval sources were available — reason from general knowledge only and clearly flag uncertainty.\n';
  } else {
    for (const s of sources) {
      if (s.type === 'lancedb') {
        const ep = s.metadata.episodeNumber;
        const date = s.metadata.episodeDate;
        out += `From TWiST Episode ${ep} (${date}): "${s.content.slice(0, 250)}"\n\n`;
      } else if (s.type === 'tavily') {
        const dom = s.metadata.domain || s.url || 'web';
        out += `Web context (${dom}): ${s.content.slice(0, 250)}\n\n`;
      } else if (s.type === 'grokipedia') {
        out += `Reference: ${s.content.slice(0, 350)}\n\n`;
      }
    }
  }
  return out;
}
