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

const NAMED_ENTITY_HEURISTIC = /[A-Z][a-z]+\s+[A-Z][a-z]+|\b[A-Z]{2,}\b/;

export async function queryLanceDB(claim: ClaimClassification): Promise<RetrievedSource[]> {
  if (isBreakerOpen('lancedb')) return [];

  const queryText = (claim.searchableNoun || claim.primaryEntity || '').trim();
  if (!queryText) return [];

  try {
    const results = await queryMemory(queryText, 5);
    recordSuccess('lancedb');

    const entityLc = (claim.primaryEntity || '').toLowerCase();
    const filtered = results
      .filter((r) => {
        const textLc = r.text.toLowerCase();
        const hasEntityOverlap = entityLc.length > 2 && textLc.includes(entityLc);
        const hasNamedEntity = NAMED_ENTITY_HEURISTIC.test(r.text);
        return hasEntityOverlap || (r.score > 0.5 && hasNamedEntity);
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

export async function queryTavily(claim: ClaimClassification): Promise<RetrievedSource[]> {
  if (isBreakerOpen('tavily')) return [];
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[RETRIEVAL] TAVILY_API_KEY not set — skipping Tavily');
    return [];
  }

  const parts: string[] = [];
  if (claim.primaryEntity) parts.push(claim.primaryEntity);
  if (claim.keyNumbers && claim.keyNumbers.length > 0) parts.push(claim.keyNumbers[0]);
  if (claim.claimType && claim.claimType !== 'unknown') parts.push(claim.claimType);
  const query = parts.join(' ').trim();
  if (!query) return [];

  try {
    const client = tavily({ apiKey });
    const response = await client.search(query, {
      searchDepth: 'basic',
      maxResults: 5,
      includeDomains: ['sec.gov', 'bloomberg.com', 'techcrunch.com', 'reuters.com'],
    });
    recordSuccess('tavily');

    const sources: RetrievedSource[] = [];
    for (const r of response.results || []) {
      const tier = classifyDomain(r.url);
      if (tier === 4) continue;
      let domain: string | undefined;
      try {
        domain = new URL(r.url).hostname.replace(/^www\./, '');
      } catch {
        domain = undefined;
      }
      sources.push({
        id: `tavily_${Date.now()}_${sources.length}`,
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
      if (sources.length >= 4) break;
    }
    return sources;
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

export async function retrieve(claim: ClaimClassification): Promise<RetrievalResult> {
  const tStart = Date.now();
  const [lr, tr, gr] = await Promise.all([
    timed(() => withTimeout(queryLanceDB(claim), 300, 'lancedb').catch(() => [] as RetrievedSource[])),
    timed(() => withTimeout(queryTavily(claim), 1200, 'tavily').catch(() => [] as RetrievedSource[])),
    timed(() => withTimeout(queryGrokipedia(claim), 1500, 'grokipedia').catch(() => [] as RetrievedSource[])),
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

export function formatForDocket(
  sources: RetrievedSource[],
  claim: ClaimClassification,
  recentSegments: TranscriptSegment[]
): string {
  let out = `CLAIM: ${claim.claimText}\nSPEAKER: ${claim.speaker}\n\n`;
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
      out += `[${i + 1}] ${s.title} | ${url} | Tier ${s.tier}\n`;
      const excerpt = s.content.slice(0, 200);
      out += `Excerpt: "${excerpt}${s.content.length > 200 ? '…' : ''}"\n\n`;
    });
  }
  return out;
}

export function formatForPattern(
  sources: RetrievedSource[],
  claim: ClaimClassification,
  recentSegments: TranscriptSegment[]
): string {
  let out = `CLAIM: ${claim.claimText}\nSPEAKER: ${claim.speaker}\n\n`;
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
