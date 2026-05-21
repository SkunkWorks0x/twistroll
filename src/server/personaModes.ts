// Runtime-mutable settings the Customize panel controls.
//
// One Docket agent. These modes are evidence-locked voice fragments — they
// alter wording in the Docket system prompt only. Verdict logic, citation
// pipeline, anti-pattern scan, and post-processing remain mode-invariant.
//
// Also holds the explanation word max, source-chip strictness, and classifier
// confidence threshold — every runtime knob the panel exposes lives here so
// the rest of the server has one place to read them from.

export type PersonaMode = 'producer' | 'on-air' | 'analyst' | 'cynic';
export type Strictness = 'tier1' | 'balanced' | 'broad';
export type Density = 'quiet' | 'normal' | 'aggressive';

const VALID_MODES: readonly PersonaMode[] = ['producer', 'on-air', 'analyst', 'cynic'];
const VALID_STRICTNESS: readonly Strictness[] = ['tier1', 'balanced', 'broad'];
const VALID_DENSITY: readonly Density[] = ['quiet', 'normal', 'aggressive'];

export function isPersonaMode(v: unknown): v is PersonaMode {
  return typeof v === 'string' && (VALID_MODES as readonly string[]).includes(v);
}
export function isStrictness(v: unknown): v is Strictness {
  return typeof v === 'string' && (VALID_STRICTNESS as readonly string[]).includes(v);
}
export function isDensity(v: unknown): v is Density {
  return typeof v === 'string' && (VALID_DENSITY as readonly string[]).includes(v);
}

let mode: PersonaMode = 'producer';
let explanationWordMax = 40;
let strictness: Strictness = 'balanced';
let classifierConfidenceThreshold = (() => {
  const env = parseFloat(process.env.CLAIM_CONFIDENCE_THRESHOLD || '0.7');
  return Number.isFinite(env) && env > 0 && env <= 1 ? env : 0.7;
})();

export function getCurrentMode(): PersonaMode { return mode; }
export function setCurrentMode(next: PersonaMode): void { mode = next; }

export function getExplanationWordMax(): number { return explanationWordMax; }
export function setExplanationWordMax(n: number): void {
  if (!Number.isFinite(n)) return;
  explanationWordMax = Math.max(8, Math.min(200, Math.round(n)));
}

export function getStrictness(): Strictness { return strictness; }
export function setStrictness(next: Strictness): void { strictness = next; }
// Source chips with tier > this are hidden in the dashboard. Citations and
// retrieval evidence still flow through unchanged — strictness is a display
// filter, not an evidence filter.
export function getMaxDisplayTier(): 1 | 2 | 3 {
  return strictness === 'tier1' ? 1 : strictness === 'broad' ? 3 : 2;
}

export function getClassifierConfidenceThreshold(): number { return classifierConfidenceThreshold; }
export function setDensity(next: Density): void {
  classifierConfidenceThreshold = next === 'quiet' ? 0.85 : next === 'aggressive' ? 0.55 : 0.7;
}
export function getDensity(): Density {
  if (classifierConfidenceThreshold >= 0.8) return 'quiet';
  if (classifierConfidenceThreshold <= 0.6) return 'aggressive';
  return 'normal';
}

export interface PersonaFragment {
  // Appended after the GROUNDING section in the Docket prompt. Empty for
  // Producer (the static GROUNDING paragraph is the producer-mode instruction).
  groundingInstructions: string;
  // Replaces the "VOICE: …" line in the Docket prompt. Producer reuses the
  // verbatim May 2026 line so producer-mode prompts stay byte-identical.
  explanationVoice: string;
  // Appended after the VERDICT RULES section. Empty for Producer.
  verdictGuidance: string;
}

const PRODUCER: PersonaFragment = {
  explanationVoice:
    'VOICE: Clinical precision. Senior research librarian. "The record is the record." Zero fluff, zero editorializing, zero speculation.',
  groundingInstructions: '',
  verdictGuidance: '',
};

const ON_AIR: PersonaFragment = {
  explanationVoice:
    'VOICE: Broadcast register — short, direct, host-readable on air. Active voice. No filler verbs. Plain wording. Target 12–16 words in the explanation.',
  groundingInstructions:
    'BROADCAST GROUNDING: One short sentence, no clause-stacking. The host will read this on air.',
  verdictGuidance: '',
};

const ANALYST: PersonaFragment = {
  explanationVoice:
    'VOICE: Deeper grounding. Name sources by publication when it tightens precision ("Reuters [1]" not "the source"). Use the full word budget. Surface the specific gap that prevents a higher-confidence verdict.',
  groundingInstructions:
    'ANALYST GROUNDING: Use the full grounding budget. State what each cited source directly establishes, what it does not, and which specific assertion remains open. Reference at least two citations when available.',
  verdictGuidance:
    'ANALYST VERDICTS: Prefer PARTIAL with detailed citation context over UNVERIFIABLE — explain what is and is not established by the sources.',
};

const CYNIC: PersonaFragment = {
  explanationVoice:
    'VOICE: Plain, direct, slightly skeptical register — still rule-bound. No precedent or pattern language. When evidence in the explanation is thin, say so plainly. Do not output the word "cynic" or any precedent-based framing.',
  groundingInstructions:
    'STRICT GROUNDING: State exactly which assertion in the claim each source addresses and which it leaves uncovered. Do not paper over gaps. If no source directly addresses the assertion, say so explicitly.',
  // Verdict guidance intentionally empty — Cynic is wording-only per the
  // shipped guarantee "Voice changes wording. Evidence stays locked." The
  // verdict logic must remain mode-invariant.
  verdictGuidance: '',
};

export function getPersonaFragment(m: PersonaMode = mode): PersonaFragment {
  switch (m) {
    case 'on-air':  return ON_AIR;
    case 'analyst': return ANALYST;
    case 'cynic':   return CYNIC;
    case 'producer':
    default:        return PRODUCER;
  }
}
