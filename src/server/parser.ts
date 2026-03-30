import type { OpenOatsUtterance, ParsedUtterance } from '../shared/types.js';

let utteranceCounter = 0;

/**
 * Parse a single JSONL line from OpenOats.
 * Returns null if the line is malformed, empty, or not a substantive utterance.
 */
export function parseUtterance(line: string): ParsedUtterance | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: OpenOatsUtterance;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    console.log(`[parser] JSON parse failed: ${trimmed.slice(0, 80)}... — ${err instanceof Error ? err.message : err}`);
    return null;
  }

  // Must have speaker and text at minimum
  if (!raw.speaker || !raw.text) {
    console.log(`[parser] Missing speaker or text: speaker=${raw.speaker}, text=${!!raw.text}`);
    return null;
  }

  // Prefer refinedText over raw text (it's the LLM-cleaned version)
  const text = (raw.refinedText && raw.refinedText.trim().length > 0)
    ? raw.refinedText
    : raw.text;

  // Filter: skip utterances < 10 words (not substantive)
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 10) {
    console.log(`[parser] Skipped (${wordCount} words < 10): "${text.slice(0, 60)}..."`);
    return null;
  }

  // Parse timestamp — Swift Date encodes as ISO 8601 string
  let timestamp: number;
  if (typeof raw.timestamp === 'string') {
    timestamp = new Date(raw.timestamp).getTime();
  } else if (typeof raw.timestamp === 'number') {
    // Handle Unix epoch (seconds or milliseconds)
    timestamp = raw.timestamp > 1e12 ? raw.timestamp : raw.timestamp * 1000;
  } else {
    timestamp = Date.now();
  }

  utteranceCounter++;

  return {
    speaker: raw.speaker,
    text,
    timestamp,
    id: `utt_${utteranceCounter.toString().padStart(4, '0')}`,
  };
}
