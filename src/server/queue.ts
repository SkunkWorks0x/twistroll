import type { ParsedUtterance, PersonaId, TrollReaction, LlmEngine, SoundCueMessage } from '../shared/types.js';
import { appConfig } from '../config/config.js';
import { PERSONAS } from './personas.js';
import { buildContext, addUtterance, getDailyBriefBlock } from './context.js';
import { callOllama, isOllamaAvailable } from './ollama.js';
import { cloudGenerate } from './cloud-llm.js';
import { groqGenerate } from './groq-llm.js';
import { callLLM } from './llm-router.js';
import { logReaction } from './logger.js';

// Queue can emit both text bubbles (TrollReaction) and Fred sound cues
// (SoundCueMessage). The caller (index.ts) forwards both to broadcast().
type ReactionCallback = (message: TrollReaction | SoundCueMessage) => void;

let lastProcessedTime = 0;
let processing = false;
let rotationIndex = 0;
let viewerRotationIndex = 0;

// Slot 'not-ad' is a visual-pacing yield, not a generated persona.
// When the rotation lands on it AND a real Not Ad bubble has fired in the
// recent window, this slot is left empty so the bubble has breathing room.
// Otherwise the slot is skipped immediately and the next persona fires.
type RotationSlot = PersonaId | 'not-ad';
const ROTATION: RotationSlot[] = [
  'not-jamie',
  'not-delinquent',
  'not-taco',
  'not-robin',
  'not-fred',
  'not-ad',
];
const NOT_AD_PACE_WINDOW_MS = 30_000;
let lastNotAdFireMs = 0;
export function recordNotAdFire(): void {
  lastNotAdFireMs = Date.now();
}

// Viewer comments only rotate through the chaos twins.
const VIEWER_ROTATION: PersonaId[] = ['not-delinquent', 'not-taco'];

// Viewer comments use a shorter cooldown so chat feels real-time.
const VIEWER_COOLDOWN_MS = 5000;

// Jason-ism phrases — when the host says these, force Taco next
const JASON_ISMS = [
  "let me push back",
  "push back on that",
  "i gotta be honest",
  "gotta be honest",
  "totally honest",
  "no seriously",
  "no, seriously",
  "god bless you",
  "god bless",
  "whoooo",
  "whooo",
  "whoa",
  "great question",
  "i'm going to riff",
  "riff on this",
  "no bueno",
  "come again",
  "holy shit",
  "that's just insane"
];

// Personas that are toggled on by default. Filter out 'not-ad' (visual-pacing
// slot, not a generated persona) AND any entries in DEFAULT_DISABLED_PERSONAS
// below (not spec-required; producer can enable via config panel).
const DEFAULT_DISABLED_PERSONAS: PersonaId[] = [
  'not-robin', // Experimental 5th persona — pending NEWS-SHAPE refinement. Not spec-required.
];
const enabledPersonas = new Set<PersonaId>(
  ROTATION.filter((r): r is PersonaId => r !== 'not-ad' && !DEFAULT_DISABLED_PERSONAS.includes(r as PersonaId))
);

// Sponsor suppression — suppress troll reactions during ad reads
let sponsorSuppressUntil: number = 0;

// Robin consecutive-skip counter. If Robin says SKIP 3 times in a row, the
// 4th rotation forces her output through regardless of content — keeps the
// bubble visually alive even when no news angle exists for a stretch.
let consecutiveRobinSkips = 0;

// Fred consecutive-skip counter — same force-through semantics as Robin.
// Fred's SKIP is signaled by {"sound": "none", "text": "SKIP"} JSON payload.
let consecutiveFredSkips = 0;

// Per-session Robin headline dedup. Grok paraphrases the same brief headline
// multiple ways; we fingerprint the first 8 significant words of each Robin
// broadcast and suppress matches. In-memory only — resets on server restart.
const firedRobinHeadlines = new Set<string>();
function robinFingerprint(text: string): string {
  return text.toLowerCase().replace(/^news:\s*/i, '').split(/\s+/).slice(0, 8).join(' ');
}

// Fred threshold injected from env (default 9/10 — battle-tested across 5 anti-fabrication rounds).
// Override with FRED_TRIGGER_THRESHOLD=7 npm run dev for demo recording. Do not lower the default.
const FRED_TRIGGER_THRESHOLD = process.env.FRED_TRIGGER_THRESHOLD || '9';
console.log(`[FRED-HB] BOOT threshold=${FRED_TRIGGER_THRESHOLD} cooldown=${Math.round(appConfig.cooldownMs / 1000)}s sound_library=12`);

/**
 * Generate a response using the configured LLM mode.
 * hybrid: cloud → groq → ollama
 * cloud:  cloud only (no fallback)
 * local:  ollama only
 */
export async function generate(
  model: string,
  systemPrompt: string,
  userMessage: string,
  personaId?: string
): Promise<{ text: string; engine: LlmEngine }> {
  const mode = appConfig.llmMode;

  if (mode === 'local') {
    return { text: await callOllama(model, systemPrompt, userMessage), engine: 'ollama' };
  }

  if (mode === 'cloud') {
    return { text: await cloudGenerate(systemPrompt, userMessage, personaId), engine: 'cloud' };
  }

  // hybrid: cloud → groq → ollama
  try {
    const text = await cloudGenerate(systemPrompt, userMessage, personaId);
    return { text, engine: 'cloud' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[queue] Cloud failed: ${msg} — trying Groq`);
  }

  try {
    const text = await groqGenerate(systemPrompt, userMessage);
    return { text, engine: 'groq' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[queue] Groq failed: ${msg} — falling back to Ollama`);
  }

  return { text: await callOllama(model, systemPrompt, userMessage), engine: 'ollama' };
}

/**
 * Find the next enabled persona in rotation order.
 * Skips disabled personas, wraps around.
 */
function nextPersona(): PersonaId | null {
  // Loop up to 2× length so a recent-not-ad-yield can pass through and
  // the next real persona is reached on the same call.
  for (let i = 0; i < ROTATION.length * 2; i++) {
    const id = ROTATION[rotationIndex % ROTATION.length];
    rotationIndex++;
    if (id === 'not-ad') {
      // Slot 5 — Not Ad is fired by index.ts on detection events, not here.
      // Yield this slot (return null to leave the utterance unanswered) ONLY
      // if Not Ad has fired recently — gives the Not Ad bubble visual space.
      // Otherwise skip immediately so we don't waste a turn on an empty slot.
      if (Date.now() - lastNotAdFireMs < NOT_AD_PACE_WINDOW_MS) {
        return null;
      }
      continue;
    }
    if (enabledPersonas.has(id)) return id;
  }
  return null; // all disabled
}

/**
 * Pick the next persona for a viewer comment — round-robin over
 * [delinquent, taco] only. Skips disabled personas.
 */
function nextViewerPersona(): PersonaId | null {
  for (let i = 0; i < VIEWER_ROTATION.length; i++) {
    const id = VIEWER_ROTATION[viewerRotationIndex % VIEWER_ROTATION.length];
    viewerRotationIndex++;
    if (enabledPersonas.has(id)) return id;
  }
  return null;
}

/**
 * Process a new utterance — one persona per utterance, round-robin.
 */
export async function processUtterance(
  utterance: ParsedUtterance,
  onReaction: ReactionCallback
): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastProcessedTime;
  const isViewer = utterance.speaker === 'viewer';
  const activeCooldown = isViewer ? VIEWER_COOLDOWN_MS : appConfig.cooldownMs;

  console.log(`[queue] Received utterance ${utterance.id} (speaker=${utterance.speaker}): cooldown=${timeSinceLast}ms / ${activeCooldown}ms, processing=${processing}`);

  // Sponsor suppression gate
  if (Date.now() < sponsorSuppressUntil) {
    console.log('[queue] Suppressed during ad break');
    if (!isViewer && ROTATION[rotationIndex % ROTATION.length] === 'not-fred') {
      console.log(`[FRED-HB] SKIP reason=sponsor_suppression utt=${utterance.id}`);
    }
    return;
  }

  // Cooldown gate
  if (timeSinceLast < activeCooldown) {
    console.log(`[queue] DROPPED by cooldown gate: ${timeSinceLast}ms < ${activeCooldown}ms (${Math.round((activeCooldown - timeSinceLast) / 1000)}s remaining)`);
    if (!isViewer && ROTATION[rotationIndex % ROTATION.length] === 'not-fred') {
      console.log(`[FRED-HB] SKIP reason=cooldown_active remaining=${Math.round((activeCooldown - timeSinceLast) / 1000)}s utt=${utterance.id}`);
    }
    return;
  }

  // Don't stack processing
  if (processing) {
    console.log(`[queue] DROPPED — already processing another utterance`);
    if (!isViewer && ROTATION[rotationIndex % ROTATION.length] === 'not-fred') {
      console.log(`[FRED-HB] SKIP reason=processing_locked utt=${utterance.id}`);
    }
    return;
  }

  // In local/hybrid mode, check Ollama is up (needed as fallback)
  if (appConfig.llmMode !== 'cloud' && !isOllamaAvailable()) {
    console.warn(`[queue] Ollama not available (mode=${appConfig.llmMode}), skipping utterance`);
    return;
  }

  // Jason-ism detection: force Taco when host uses a catchphrase
  const latestLower = utterance.text.toLowerCase();
  const isHost = utterance.speaker === 'you';
  const hasJasonIsm = isHost && JASON_ISMS.some(ism => latestLower.includes(ism));

  let personaId: PersonaId | null;
  if (isViewer) {
    personaId = nextViewerPersona();
    if (personaId) {
      console.log(`[queue] Viewer comment → ${personaId}`);
    }
  } else if (hasJasonIsm && enabledPersonas.has('not-taco')) {
    console.log(`[queue] Jason-ism detected: "${utterance.text.substring(0, 50)}..." → forcing Not Taco`);
    personaId = 'not-taco';
    // Don't advance rotationIndex — resume normal rotation next time
  } else {
    personaId = nextPersona();
  }

  if (!personaId) {
    console.warn('[queue] All personas disabled, skipping');
    return;
  }

  if (!isViewer && personaId !== 'not-fred') {
    console.log(`[FRED-HB] SKIP reason=rotation_not_fred utt=${utterance.id}`);
  }

  processing = true;
  lastProcessedTime = now;

  // Add to context buffer
  addUtterance(utterance);

  const persona = PERSONAS[personaId];
  console.log(`[queue] Rotation → ${persona.name}: "${utterance.text.slice(0, 80)}..."`);

  try {
    const context = buildContext(personaId, utterance);

    // Robin gets her system prompt's {{DAILY_BRIEF}} placeholder substituted
    // with the currently-loaded brief headlines before the LLM call.
    let systemPrompt = persona.systemPrompt;
    if (personaId === 'not-robin') {
      systemPrompt = systemPrompt.replace('{{DAILY_BRIEF}}', getDailyBriefBlock());
    }
    if (personaId === 'not-fred') {
      systemPrompt = systemPrompt.replace(/\{\{FRED_THRESHOLD\}\}/g, FRED_TRIGGER_THRESHOLD);
    }

    const { text: routerText, provider } = await callLLM(personaId, systemPrompt, context);
    let response = routerText;
    const engine: string = provider;

    // Troll "PASS" = intentional silence per f0a233e silence-is-power.
    // No force-through counter (unlike Robin): passes ARE the hypothesis;
    // capping would re-introduce always-fire.
    if (personaId === 'not-delinquent') {
      const trimmed = response.trim();
      if (trimmed.toUpperCase() === 'PASS') {
        console.log(`[DELINQ-HB] PASS reason=silence_is_power utt=${utterance.id}`);
        processing = false;
        return;
      }
    }

    // Robin SKIP handling. Trim + case-insensitive match on literal "SKIP".
    // Count consecutive skips; on the 4th Robin rotation (3 skips, then a
    // 4th call) force the output through even if she says SKIP again.
    if (personaId === 'not-robin') {
      const trimmed = response.trim();
      const isSkip = trimmed.toUpperCase() === 'SKIP';
      if (isSkip && consecutiveRobinSkips < 3) {
        consecutiveRobinSkips++;
        console.log(`[queue] Robin skipped — no news angle for this utterance (${consecutiveRobinSkips}/3)`);
        processing = false;
        return;
      }
      if (isSkip && consecutiveRobinSkips >= 3) {
        console.log('[queue] Robin force-through returned SKIP — suppressing bubble, resetting counter');
        consecutiveRobinSkips = 0;
        processing = false;
        return;
      }
      consecutiveRobinSkips = 0;

      // Per-session headline dedup — Grok paraphrases repeat sources.
      const fp = robinFingerprint(trimmed);
      if (fp && firedRobinHeadlines.has(fp)) {
        consecutiveRobinSkips++;
        console.log(`[queue] Robin headline already fired this session — suppressing (${consecutiveRobinSkips}/3)`);
        processing = false;
        return;
      }
      if (fp) firedRobinHeadlines.add(fp);
    }

    // Fred returns JSON: {"sound": "rimshot", "text": "🔊 RIMSHOT — ..."}.
    // Parse it, emit a sound_cue message if sound != "none", and set the
    // text bubble to .text. Malformed JSON falls back to plain-text broadcast.
    // SKIP handling mirrors Robin: 3 consecutive → force-through on 4th.
    if (personaId === 'not-fred') {
      const trimmed = response.trim();
      let parsed: { sound?: unknown; text?: unknown } | null = null;
      try {
        // Strip markdown code-fence wrappers if present (some models add them)
        const jsonCandidate = trimmed
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();
        parsed = JSON.parse(jsonCandidate);
      } catch {
        parsed = null;
      }

      if (parsed && typeof parsed === 'object') {
        const sound = typeof parsed.sound === 'string' ? parsed.sound : 'none';
        const fredText = typeof parsed.text === 'string' ? parsed.text : '';
        const isSkip = sound === 'none' && fredText.trim().toUpperCase() === 'SKIP';

        if (isSkip && consecutiveFredSkips < 3) {
          consecutiveFredSkips++;
          console.log(`[queue] Fred skipped — no sound/context fit (${consecutiveFredSkips}/3)`);
          console.log(`[FRED-HB] SKIP reason=llm_skip_counted n=${consecutiveFredSkips}/3 utt=${utterance.id}`);
          processing = false;
          return;
        }
        if (isSkip && consecutiveFredSkips >= 3) {
          console.log('[queue] Fred force-through returned SKIP — suppressing bubble, resetting counter');
          console.log(`[FRED-HB] SKIP reason=llm_skip_forcethrough_suppressed utt=${utterance.id}`);
          consecutiveFredSkips = 0;
          processing = false;
          return;
        }
        consecutiveFredSkips = 0;

        // Emit the sound cue as a SEPARATE message before the text bubble.
        if (sound !== 'none' && sound.trim().length > 0) {
          onReaction({ type: 'sound_cue', sound });
          console.log(`[queue] Fred sound cue: ${sound}`);
          console.log(`[FRED-HB] FIRE sound=${sound} utt=${utterance.id}`);
        }

        // The text bubble gets the parsed .text (may be empty for
        // serious-topic silence per spec — bail if so).
        if (!fredText.trim()) {
          console.log('[queue] Fred silent on serious topic — no bubble');
          console.log(`[FRED-HB] SKIP reason=silent_serious_topic utt=${utterance.id}`);
          processing = false;
          return;
        }
        response = fredText;
      } else {
        console.warn('[queue] Fred returned non-JSON, falling back to plain text');
        console.log(`[FRED-HB] SKIP reason=malformed_json utt=${utterance.id}`);
        // Leave `response` as-is; normal downstream truncation handles it.
      }
    }

    // Empty response from router (all providers exhausted). Bail silently
    // rather than broadcasting an empty bubble.
    if (!response.trim()) {
      console.warn(`[queue] ${persona.name} returned empty — all providers exhausted, skipping broadcast`);
      processing = false;
      return;
    }

    // Strip wrapping quotes
    response = response.replace(/^["'"]+|["'"]+$/g, '');

    // Take first sentence only
    const sentenceMatch = response.match(/^(.*?(?:\.\s|\." |[!?]))/);
    if (sentenceMatch) {
      response = sentenceMatch[1].trimEnd();
    }

    // Hard cap at 200 chars, break at last word boundary
    if (response.length > 200) {
      const truncated = response.slice(0, 200);
      const lastSpace = truncated.lastIndexOf(' ');
      response = (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated.trimEnd()) + '\u2026';
    }

    // Filter flat non-responses from Not Jamie (and any persona).
    // Categories: trailing/incomplete speech, meta fact-check refusals,
    // vague/unverifiable classifications, transcription quality complaints.
    const flatResponses = [
      /^that'?s (opinion|vague|prediction)/i,
      /^statement is vague/i,
      /^no verifiable claim/i,
      /^unclear (if|whether)/i,
      /^not enough (context|data|information)/i,
      /empty string/i,
      /no contradiction/i,
      /no falsifiable/i,
      /no hidden assumption/i,
      /no reaction needed/i,
      /sponsorship read/i,
      /too fragmented/i,
      /too garbled/i,
      /not a factual claim/i,
      /no specific number/i,
      /can't land/i,
      /hitting a wall/i,
      /transcript quality/i,
      /word salad/i,
      /I appreciate the setup/i,
      /I can't provide/i,
      // Jamie explanation leaks
      /can't parse/i,
      /garbled transmission/i,
      /design pattern issue/i,
      /not a fact.?check/i,
      /no new claim/i,
      /repeats the previous/i,
      /transcription error/i,
      /without establishing the connection/i,
      /without a falsifiable claim/i,
      /trails mid-thought/i,
      /circling back without/i,
      /needs clarification on whether/i,
      /the statement trails/i,
      /unclear how .+ relates/i,
      /shifted from discussing/i,
      // Meta-commentary about transcription quality
      /wouldn't accept that output/i,
      /had a stroke/i,
      // Jamie non-reactions
      /no contradiction detected/i,
      // Taco meta-commentary
      /can't land the dunk/i,
      // Character-breaking meta-commentary about content type
      /can'?t fact.?check/i,
      /without a factual claim/i,
      /personal anecdote/i,
      /not a business claim/i,
      /culture discourse/i,
      /no verifiable/i,
      /nothing to fact/i,
      /no concrete claim/i,
      /doesn'?t contain.*claim/i,
      /no specific.*to (check|verify)/i,
      /couldn'?t finish/i,
      /couldn'?t complete/i,
      // ep 2275 live test — trailing speech, testability refusals
      /trails mid-sentence/i,
      /trails off mid-thought/i,
      /no specific claim/i,
      /loops without a testable claim/i,
      /hard to isolate a falsifiable claim/i,
      /generic principle/i,
    ];
    if (flatResponses.some((pat) => pat.test(response))) {
      console.log(`[queue] ${persona.name} gave flat response, suppressing: "${response}"`);
      processing = false;
      return;
    }

    const reaction: TrollReaction = {
      type: 'troll_comment',
      persona: personaId,
      text: response,
      timestamp: Date.now(),
      utteranceId: utterance.id,
    };

    onReaction(reaction);
    logReaction(personaId, response, utterance.text, engine);

    console.log(`[queue] ${persona.name} [${engine}]: "${response}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[queue] ${persona.name} failed: ${msg}`);
  }

  processing = false;
}

export function togglePersona(id: PersonaId, enabled: boolean): void {
  if (enabled) {
    enabledPersonas.add(id);
  } else {
    enabledPersonas.delete(id);
  }
}

export function isProcessing(): boolean {
  return processing;
}

export function setCooldown(ms: number): void {
  appConfig.cooldownMs = ms;
}

export function startSponsorSuppression(): void {
  sponsorSuppressUntil = Date.now() + 45000;
  console.log('[queue] Sponsor detected — suppressing troll reactions for 45s');
}
