import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Dossier {
  name: string;
  company: string;
  role: string;
  recentNews: string[];
  notableClaims: string[];
  contradictionsToWatch: string[];
  loadedAt: number;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function loadDossier(guestName: string): Dossier | null {
  const slug = slugify(guestName);
  const filePath = resolve(__dirname, '..', '..', 'data', 'dossiers', `${slug}.json`);

  if (!existsSync(filePath)) {
    console.warn(`[dossier] No dossier found for "${guestName}" at ${filePath}`);
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      name: parsed.name ?? guestName,
      company: parsed.company ?? '',
      role: parsed.role ?? '',
      recentNews: Array.isArray(parsed.recentNews) ? parsed.recentNews : [],
      notableClaims: Array.isArray(parsed.notableClaims) ? parsed.notableClaims : [],
      contradictionsToWatch: Array.isArray(parsed.contradictionsToWatch) ? parsed.contradictionsToWatch : [],
      loadedAt: Date.now(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[dossier] Failed to parse dossier for "${guestName}": ${msg}`);
    return null;
  }
}

export function formatDossierBlock(d: Dossier): string {
  return (
    `[GUEST DOSSIER]\n` +
    `Name: ${d.name}\n` +
    `Company: ${d.company}\n` +
    `Role: ${d.role}\n` +
    `Recent: ${d.recentNews.join(' | ')}\n` +
    `Notable claims: ${d.notableClaims.join(' | ')}\n` +
    `Watch for contradictions: ${d.contradictionsToWatch.join(' | ')}\n`
  );
}
