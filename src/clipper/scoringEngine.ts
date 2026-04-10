import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { queryMemory } from '../server/episodeMemory.js';
import type { MomentCandidate, VirialityScore, PersonaReaction } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const FEEDBACK_PATH = resolve(ROOT, 'data', 'feedback.json');
const HOTKEYS_PATH = resolve(ROOT, 'data', 'clipper', 'hotkeys.jsonl');

const HEURISTIC_LLM_TIMEOUT_MS = 3000;

// ─── Persona consensus (40 points max) ────────────────────────────────
function scorePersonaConsensus(reactions: PersonaReaction[]): { score: number; explanation: string } {
  const uniquePersonas = new Set(reactions.map((r) => r.persona));
  const n = uniquePersonas.size;
  let base = 0;
  if (n === 1) base = 10;
  else if (n === 2) base = 25;
  else if (n === 3) base = 35;
  else if (n >= 4) base = 40;

  const thumbsBonus = reactions.some((r) => r.thumbsUp) ? 5 : 0;
  const total = Math.min(40, base + thumbsBonus);
  return {
    score: total,
    explanation: `${n} persona${n === 1 ? '' : 's'} reacted${thumbsBonus > 0 ? ' (+thumbs-up)' : ''}`,
  };
}

// ─── Memory match (25 points max) ─────────────────────────────────────
async function scoreMemoryMatch(transcript: string): Promise<{ score: number; explanation: string }> {
  if (!transcript.trim()) return { score: 0, explanation: 'no transcript' };
  try {
    const results = await queryMemory(transcript.slice(0, 800), 3);
    if (results.length === 0) return { score: 0, explanation: 'no memory matches' };
    const top = results[0].score;
    let score = 0;
    if (top > 0.55) score = 25;
    else if (top >= 0.50) score = 15;
    else if (top >= 0.46) score = 8;
    return {
      score,
      explanation: `top memory match=${top.toFixed(3)} (Ep ${results[0].episodeNumber})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { score: 0, explanation: `memory query failed: ${msg}` };
  }
}

// ─── Explicit thumbs-up from feedback.json (15 points max) ────────────
function scoreExplicitThumbs(reactions: PersonaReaction[]): { score: number; explanation: string } {
  if (!existsSync(FEEDBACK_PATH)) return { score: 0, explanation: 'no feedback file' };
  try {
    const data = JSON.parse(readFileSync(FEEDBACK_PATH, 'utf-8')) as Record<
      string,
      { positive_reactions: string[] }
    >;
    for (const r of reactions) {
      const positives = data[r.persona]?.positive_reactions ?? [];
      // Match if any stored positive reaction text overlaps with this reaction's text
      if (positives.some((p) => p && r.text && (r.text.includes(p) || p.includes(r.text)))) {
        return { score: 15, explanation: `matched thumbs-up on ${r.persona}` };
      }
    }
    return { score: 0, explanation: 'no thumbs-up matches' };
  } catch {
    return { score: 0, explanation: 'feedback parse failed' };
  }
}

// ─── Transcript heuristics via Haiku (15 points max, strict timeout) ──
async function scoreTranscriptHeuristics(transcript: string): Promise<{ score: number; explanation: string }> {
  if (!transcript.trim()) return { score: 0, explanation: 'no transcript' };
  const apiKey = process.env.CLOUD_API_KEY;
  if (!apiKey) return { score: 0, explanation: 'no CLOUD_API_KEY' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEURISTIC_LLM_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system:
          'You score podcast moments for viral potential (laughs, hot takes, surprise, controversy, strong claims). Respond with ONLY a single integer 0-15. No words.',
        messages: [{ role: 'user', content: transcript.slice(0, 800) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { score: 0, explanation: `heuristic http ${res.status}` };
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text?.trim() ?? '';
    const n = parseInt(raw, 10);
    if (isNaN(n)) return { score: 0, explanation: `heuristic parse fail: "${raw}"` };
    const clamped = Math.max(0, Math.min(15, n));
    return { score: clamped, explanation: `heuristic LLM scored ${clamped}/15` };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { score: 0, explanation: `heuristic timeout/fail (${msg.slice(0, 40)})` };
  }
}

// ─── Manual hotkey override (5 points max) ────────────────────────────
function scoreManualOverride(
  windowStart: number,
  windowEnd: number
): { score: number; explanation: string } {
  if (!existsSync(HOTKEYS_PATH)) return { score: 0, explanation: 'no hotkeys file' };
  try {
    const lines = readFileSync(HOTKEYS_PATH, 'utf-8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { timestamp: number; reason?: string };
        if (entry.timestamp >= windowStart && entry.timestamp <= windowEnd) {
          return { score: 5, explanation: `hotkey: ${entry.reason ?? 'manual'}` };
        }
      } catch {
        /* skip malformed line */
      }
    }
    return { score: 0, explanation: 'no hotkey in window' };
  } catch {
    return { score: 0, explanation: 'hotkey read failed' };
  }
}

// ─── Main entry ────────────────────────────────────────────────────────
export async function scoreMoment(candidate: MomentCandidate): Promise<VirialityScore> {
  const [consensus, memory, thumbs, heuristics, manual] = await Promise.all([
    Promise.resolve(scorePersonaConsensus(candidate.reactionsInWindow)),
    scoreMemoryMatch(candidate.transcript),
    Promise.resolve(scoreExplicitThumbs(candidate.reactionsInWindow)),
    scoreTranscriptHeuristics(candidate.transcript),
    Promise.resolve(scoreManualOverride(candidate.windowStart, candidate.windowEnd)),
  ]);

  const signals = {
    personaConsensus: consensus.score,
    memoryMatch: memory.score,
    explicitThumbs: thumbs.score,
    transcriptHeuristics: heuristics.score,
    manualOverride: manual.score,
  };
  const total =
    signals.personaConsensus +
    signals.memoryMatch +
    signals.explicitThumbs +
    signals.transcriptHeuristics +
    signals.manualOverride;

  const explanation = [
    `consensus=${signals.personaConsensus} (${consensus.explanation})`,
    `memory=${signals.memoryMatch} (${memory.explanation})`,
    `thumbs=${signals.explicitThumbs} (${thumbs.explanation})`,
    `heuristics=${signals.transcriptHeuristics} (${heuristics.explanation})`,
    `manual=${signals.manualOverride} (${manual.explanation})`,
  ].join(' · ');

  return { total, signals, explanation };
}
