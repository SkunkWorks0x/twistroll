// Lightweight entity alias normalization for classifier output.
//
// Intended integration point (do not wire here without sacred-file approval):
// in src/server/classifier.ts, inside classifyWindow(), after `claimText`,
// `primaryEntity`, and `searchableNoun` are read from parsed LLM JSON and
// before the returned ClaimClassification object is constructed. Normalize
// those string fields before they hit the gate stack, claim queue, and
// retrieval layer.

export const entityAliases = new Map<string, string>([
  ['Wade', 'Wayve'],
  ['WAVE', 'Wayve'],
  ['Wave', 'Wayve'],
  ['Wobby', 'Waabi'],
  ['Wabi', 'Waabi'],
  ['Open AI', 'OpenAI'],
  ['Chat GPT', 'ChatGPT'],
  ['Anthropic', 'Anthropic'],
  ['In Vidia', 'NVIDIA'],
  ['N Vidia', 'NVIDIA'],
  ['Navidia', 'NVIDIA'],
  ['A sixteen Z', 'a16z'],
  ['A 16 Z', 'a16z'],
  ['Andreesen Horowitz', 'Andreessen Horowitz'],
  ['Andreessen Horowits', 'Andreessen Horowitz'],
  ['Mark Anderson', 'Marc Andreessen'],
  ['Marc Anderson', 'Marc Andreessen'],
  ['Mass Yoshi Son', 'Masayoshi Son'],
  ['Masayoshi Sun', 'Masayoshi Son'],
  ['Elon Must', 'Elon Musk'],
  ['Elan Musk', 'Elon Musk'],
  ['Sam Altmann', 'Sam Altman'],
  ['Y Combinater', 'Y Combinator'],
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias: string): RegExp {
  const escaped = escapeRegExp(alias).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
}

function applyCasing(match: string, replacement: string): string {
  if (match.toUpperCase() === match && !/\d/.test(replacement)) return replacement.toUpperCase();
  return replacement;
}

export function normalizeEntities(text: string): string {
  let out = text;
  for (const [alias, canonical] of entityAliases) {
    out = out.replace(aliasPattern(alias), (match) => applyCasing(match, canonical));
  }
  return out;
}
