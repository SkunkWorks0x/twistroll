export interface Sponsor {
  name: string;
  url: string;
  code?: string;
  copy: string;
}

const SPONSORS: Record<string, Sponsor> = {
  plaud: {
    name: 'Plaud',
    url: 'https://plaud.ai/twist',
    copy: 'Try Plaud Notes free \u2192 plaud.ai/twist',
  },
  linkedin: { // TODO: verify URL — twist.ly domain is down
    name: 'LinkedIn',
    url: 'twist.ly/linkedin',
    copy: 'Post your first job free \u2192 twist.ly/linkedin',
  },
  squarespace: { // TODO: verify URL — twist.ly domain is down
    name: 'Squarespace',
    url: 'twist.ly/squarespace',
    code: 'TWIST',
    copy: 'Use code TWIST for 10% off \u2192 twist.ly/squarespace',
  },
  northwest: {
    name: 'Northwest Registered Agent',
    url: 'https://northwestregisteredagent.com/twist',
    copy: 'Form your LLC \u2192 northwestregisteredagent.com/twist',
  },
  vanta: { // TODO: verify URL — twist.ly domain is down
    name: 'Vanta',
    url: 'twist.ly/vanta',
    copy: '$1000 off \u2192 twist.ly/vanta',
  },
  gusto: {
    name: 'Gusto',
    url: 'https://gusto.com/twist',
    copy: '3 months free \u2192 gusto.com/twist',
  },
  hubspot: { // TODO: verify URL — twist.ly domain is down
    name: 'HubSpot',
    url: 'twist.ly/hubspot',
    copy: 'Free CRM \u2192 twist.ly/hubspot',
  },
  mercury: { // TODO: verify URL — twist.ly domain is down
    name: 'Mercury',
    url: 'twist.ly/mercury',
    copy: 'Banking for startups \u2192 twist.ly/mercury',
  },
  netsuite: { // TODO: verify URL — twist.ly domain is down
    name: 'NetSuite',
    url: 'twist.ly/netsuite',
    copy: 'Free product tour \u2192 twist.ly/netsuite',
  },
  gamma: { // TODO: verify URL — twist.ly domain is down
    name: 'Gamma',
    url: 'twist.ly/gamma',
    copy: 'Create presentations \u2192 twist.ly/gamma',
  },
  lemon: { // TODO: verify URL — twist.ly domain is down
    name: 'Lemon.io',
    url: 'twist.ly/lemon',
    copy: 'Hire developers \u2192 twist.ly/lemon',
  },
  circle: { // TODO: verify URL — twist.ly domain is down
    name: 'Circle',
    url: 'twist.ly/circle',
    copy: 'Community platform \u2192 twist.ly/circle',
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
