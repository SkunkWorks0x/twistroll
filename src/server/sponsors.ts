export interface Sponsor {
  name: string;
  url: string;
  code?: string;
  copy: string;
}

// Current TWiST sponsor list as of April 2026 — 19 sponsors.
// Keyword matching is case-insensitive substring match on utterance text.
// For generic single-word brands (uber, every, luma), use multi-word
// keys to avoid false-positive matches on common english words.
// URLs marked TODO-VERIFY need producer confirmation before demo day.
const SPONSORS: Record<string, Sponsor> = {
  deel: { // TODO-VERIFY URL
    name: 'Deel',
    url: 'https://deel.com/twist',
    copy: 'Global hiring & payroll \u2192 deel.com/twist',
  },
  circle: { // TODO-VERIFY URL
    name: 'Circle',
    url: 'https://circle.com/twist',
    copy: 'Community platform \u2192 circle.com/twist',
  },
  northwest: {
    name: 'Northwest Registered Agent',
    url: 'https://northwestregisteredagent.com/twist',
    copy: 'Form your LLC \u2192 northwestregisteredagent.com/twist',
  },
  linkedin: { // catches "LinkedIn Jobs" too
    name: 'LinkedIn Jobs',
    url: 'https://linkedin.com/twist',
    copy: 'Post your first job free \u2192 linkedin.com/twist',
  },
  netsuite: { // TODO-VERIFY URL
    name: 'NetSuite',
    url: 'https://netsuite.com/twist',
    copy: 'Free product tour \u2192 netsuite.com/twist',
  },
  sentry: { // TODO-VERIFY URL
    name: 'Sentry',
    url: 'https://sentry.io/twist',
    copy: 'Observability for code \u2192 sentry.io/twist',
  },
  plaud: {
    name: 'Plaud',
    url: 'https://plaud.ai/twist',
    copy: 'Try Plaud Notes free \u2192 plaud.ai/twist',
  },
  lemon: { // catches "Lemon.io"
    name: 'Lemon.io',
    url: 'https://lemon.io/twist',
    copy: 'Hire developers \u2192 lemon.io/twist',
  },
  iru: { // TODO-VERIFY URL
    name: 'Iru',
    url: 'https://iru.ai/twist',
    copy: 'Visit iru.ai/twist',
  },
  caldera: { // catches "Caldera Lab"; TODO-VERIFY URL
    name: 'Caldera Lab',
    url: 'https://calderalab.com/twist',
    copy: 'Premium skincare \u2192 calderalab.com/twist',
  },
  hubspot: { // catches "HubSpot Creators"; TODO-VERIFY URL
    name: 'HubSpot Creators',
    url: 'https://hubspot.com/twist',
    copy: 'Free CRM \u2192 hubspot.com/twist',
  },
  'uber ai': { // multi-word key to avoid generic "uber" matches
    name: 'Uber AI Solutions',
    url: 'https://uber.com/twist',
    copy: 'Uber AI Solutions \u2192 uber.com/twist',
  },
  gusto: {
    name: 'Gusto',
    url: 'https://gusto.com/twist',
    copy: '3 months free \u2192 gusto.com/twist',
  },
  'every banking': { // multi-word key to avoid generic "every" matches
    name: 'Every Banking',
    url: 'https://every.to/twist',
    copy: 'Startup banking \u2192 every.to/twist',
  },
  wispr: { // catches "Wispr Flow"; TODO-VERIFY URL
    name: 'Wispr Flow',
    url: 'https://wisprflow.ai/twist',
    copy: 'Dictation app \u2192 wisprflow.ai/twist',
  },
  'quo ': { // trailing space prevents false matches on "status quo" / "aliquot"
    name: 'Quo',
    url: 'https://quo.com/twist',
    copy: 'Visit quo.com/twist',
  },
  athena: { // TODO-VERIFY URL
    name: 'Athena',
    url: 'https://athenago.com/twist',
    copy: 'Executive assistants \u2192 athenago.com/twist',
  },
  'ro.co': {
    name: 'Ro.co',
    url: 'https://ro.co/twist',
    copy: 'Health & wellness \u2192 ro.co/twist',
  },
  'luma ai': { // multi-word key to avoid generic "luma" matches
    name: 'Luma AI',
    url: 'https://lumalabs.ai/twist',
    copy: 'AI video generation \u2192 lumalabs.ai/twist',
  },
};

// Track last fire time per sponsor (5-minute dedupe)
const lastFired: Record<string, number> = {};

export function checkForSponsor(text: string): Sponsor | null {
  const lowerText = text.toLowerCase();

  for (const [keyword, sponsor] of Object.entries(SPONSORS)) {
    if (lowerText.includes(keyword)) {
      const now = Date.now();
      const lastTime = lastFired[keyword] || 0;

      // Don't fire same sponsor more than once per 5 minutes
      if (now - lastTime < 300000) return null;

      lastFired[keyword] = now;
      return sponsor;
    }
  }

  return null;
}
