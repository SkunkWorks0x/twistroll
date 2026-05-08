// Sentinel retrieval layer. Three parallel sources (LanceDB, Tavily, xAI/Grokipedia)
// merged into a tier-ranked, token-budgeted list of citations for synthesis.
//
// Patterns reused from elsewhere in the codebase: raw fetch for the xAI call (matches
// llm-router.ts), env-key fallback (GROK_API_KEY → XAI_API_KEY), per-source circuit
// breakers + per-source timeouts so one slow source can't stall the whole pipeline.

import { tavily } from '@tavily/core';
import { queryMemory } from './episodeMemory.js';
import type { ClaimClassification, TranscriptSegment } from '../shared/types.js';

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

// Excerpt limits — single source of truth. estimateTokens caps content at the
// same byte limit formatForDocket actually emits to the prompt, so the budget
// math reflects real prompt cost rather than full retrieved content. Adding
// a new source type requires adding its limit here.
const EXCERPT_LIMITS: Record<RetrievedSource['type'], number> = {
  lancedb: 400,
  tavily: 200,
  grokipedia: 350,
};

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

// Helpers (exported for unit testing — see scripts/test-tavily-query.ts).

// Convert numeric strings >= 1M to named-magnitude form. Sub-million values
// pass through unchanged. Strips $, %, comma punctuation before parsing so
// "$5,000,000" still humanizes to "5 million".
export function humanizeNumber(n: string): string {
  const num = parseFloat(n.replace(/[,$%]/g, ''));
  if (isNaN(num)) return n;
  if (num >= 1_000_000_000) {
    const v = num / 1_000_000_000;
    return `${num % 1_000_000_000 === 0 ? v.toFixed(0) : v.toFixed(1)} billion`;
  }
  if (num >= 1_000_000) {
    const v = num / 1_000_000;
    return `${num % 1_000_000 === 0 ? v.toFixed(0) : v.toFixed(1)} million`;
  }
  return n;
}

const PRESENT_TENSE_TRIGGERS = /\b(is|has|are|currently|available|using)\b|right now/i;
const HISTORICAL_TRIGGERS = /\b(was|were|founded|started)\b|\bback in\b/i;

function isPresentTenseClaim(claimText: string): boolean {
  const text = claimText || '';
  if (HISTORICAL_TRIGGERS.test(text)) return false;
  return PRESENT_TENSE_TRIGGERS.test(text);
}

// Guess a likely domain for the entity. TLD-bearing entities use it as-is;
// short (≤2 token) plain entities get a `.com` guess. Longer entities return
// null — too ambiguous to bet a site:-scoped query on.
function inferDomain(entity: string): string | null {
  const trimmed = entity.trim();
  if (!trimmed) return null;
  const tldMatch = trimmed.match(/[a-z0-9-]+\.(com|io|ai|org)/i);
  if (tldMatch) return tldMatch[0].toLowerCase();
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > 2) return null;
  return `${tokens.join('').toLowerCase()}.com`;
}

// Build the BROAD topical query.
// Rules (per cc-retrieval-surgical-fix Step 1):
//   1. Quote primaryEntity in literal double quotes
//   2. Humanize numbers >= 1M to named-magnitude form
//   3. Append 2026 for present-tense claims (suppressed on historical markers)
//   4. Drop claimType tokens — those belong in ranking, not search
export function buildTavilyQuery(claim: ClaimClassification): string {
  const entity = (claim.primaryEntity || '').trim();
  const numbers = (claim.keyNumbers || []).map(humanizeNumber).filter((n) => n.length > 0);

  // Strip entity tokens from searchableNoun so they don't double up with the
  // already-quoted entity term.
  const entityTokensSet = new Set(
    entity.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  );
  const descriptorTokens = (claim.searchableNoun || '')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !entityTokensSet.has(t.toLowerCase()));

  const year = isPresentTenseClaim(claim.claimText) ? '2026' : '';

  const parts: string[] = [];
  if (entity) parts.push(`"${entity}"`);
  if (numbers.length) parts.push(numbers.join(' '));
  if (descriptorTokens.length) parts.push(descriptorTokens.join(' '));
  if (year) parts.push(year);

  return parts.join(' ').trim();
}

// Build the NARROW query. Rule 5: site-scope when an entity-domain can be
// inferred; otherwise fall back to a quoted-entity advanced search.
export function buildTavilyNarrowQuery(claim: ClaimClassification): {
  query: string;
  domain: string | null;
} {
  const entity = (claim.primaryEntity || '').trim();
  if (!entity) return { query: '', domain: null };

  const numbers = (claim.keyNumbers || []).map(humanizeNumber).filter((n) => n.length > 0);
  const entityTokensSet = new Set(
    entity.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  );
  const descriptorTokens = (claim.searchableNoun || '')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !entityTokensSet.has(t.toLowerCase()));

  const claimKeywords = [...numbers, ...descriptorTokens].join(' ').trim();
  const domain = inferDomain(entity);

  if (domain) {
    return { query: `site:${domain} ${claimKeywords}`.trim(), domain };
  }
  return { query: `"${entity}" ${claimKeywords}`.trim(), domain: null };
}

export async function queryTavily(claim: ClaimClassification): Promise<RetrievedSource[]> {
  if (isBreakerOpen('tavily')) return [];
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[RETRIEVAL] TAVILY_API_KEY not set — skipping Tavily');
    return [];
  }

  const query = buildTavilyQuery(claim);
  console.log(`[RETRIEVAL] tavily query: "${query}"`);

  if (!query) return [];

  try {
    const client = tavily({ apiKey });

    // Single tier-1-biased query at basic depth. The previous narrow site:-scoped
    // query produced garbage domains and Tavily failures and was dropped.
    const resp = await client.search(query, {
      searchDepth: 'basic',
      maxResults: 5,
      includeDomains: TAVILY_TIER1_BIAS,
    });
    recordSuccess('tavily');

    // Dedup by URL, drop Tier-4.
    const byUrl = new Map<string, RetrievedSource>();
    for (const r of resp.results || []) {
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

export function estimateTokens(s: RetrievedSource): number {
  const limit = EXCERPT_LIMITS[s.type];
  const contentLen = Math.min(s.content.length, limit);
  return Math.ceil((s.title.length + contentLen) / 4);
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

function formatSpeakerLine(speakerId: number, role: string): string {
  return `SPEAKER: ${role}`;
}

export function formatForDocket(
  sources: RetrievedSource[],
  claim: ClaimClassification,
  recentSegments: TranscriptSegment[]
): string {
  let out = `CLAIM: ${claim.claimText}\n${formatSpeakerLine(claim.speakerNumber, claim.speaker)}\n\n`;
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
      const limit = EXCERPT_LIMITS[s.type];
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
  recentSegments: TranscriptSegment[]
): string {
  let out = `CLAIM: ${claim.claimText}\n${formatSpeakerLine(claim.speakerNumber, claim.speaker)}\n\n`;
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
