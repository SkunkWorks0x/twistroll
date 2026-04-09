import express from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listAllClips, updateClipStatus } from './clipStore.js';
import type { ClipCandidate } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = resolve(__dirname, 'dashboard', 'index.html');

const PORT = 3002;

export function startDashboardServer(): void {
  const app = express();
  app.use(express.json());

  const serveDashboard = (_req: express.Request, res: express.Response) => {
    try {
      res.type('html').send(readFileSync(DASHBOARD_HTML, 'utf-8'));
    } catch {
      res.status(500).send('dashboard html not found');
    }
  };
  app.get('/', serveDashboard);
  app.get('/clipper-dashboard', serveDashboard);

  app.get('/api/clips/episode-info', async (_req, res) => {
    try {
      const clips = await listAllClips();
      const top = clips.sort((a, b) => b.createdAt - a.createdAt)[0];
      res.json({
        episodeTitle: top?.episodeNumber
          ? `TWiST #${top.episodeNumber} — Live Session`
          : 'Live Session',
        episodeNumber: top?.episodeNumber ?? 0,
        candidateCount: clips.length,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/clips', async (_req, res) => {
    try {
      const clips = await listAllClips();
      // Sort by score desc and strip the vector column for payload size.
      const out = clips
        .map((c) => {
          const { vector: _v, ...rest } = c as ClipCandidate;
          return rest;
        })
        .sort((a, b) => b.score - a.score);
      res.json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/clips/:id/approve', async (req, res) => {
    try {
      const ok = await updateClipStatus(req.params.id, 'ready');
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/clips/:id/reject', async (req, res) => {
    try {
      const reason = String((req.body as { reason?: string })?.reason ?? 'no reason');
      const ok = await updateClipStatus(req.params.id, 'rejected', reason);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Gut-check tracking is client-side (localStorage); endpoint is a no-op
  // acknowledgment so the UI can log the event server-side later if desired.
  app.post('/api/clips/:id/gut-check', (_req, res) => {
    res.json({ ok: true });
  });

  // Battle mode: approve the winner + reject the loser in a single atomic call.
  app.post('/api/clips/:id/battle-win', async (req, res) => {
    try {
      const loserId = String((req.body as { loserId?: string })?.loserId ?? '');
      const winnerOk = await updateClipStatus(req.params.id, 'ready');
      let loserOk = false;
      if (loserId) {
        loserOk = await updateClipStatus(loserId, 'rejected', 'lost battle');
      }
      res.json({ ok: winnerOk, loserOk });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.listen(PORT, () => {
    console.log(`[clipper] Dashboard → http://localhost:${PORT}/clipper-dashboard`);
  });
}
