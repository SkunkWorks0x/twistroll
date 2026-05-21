// One-shot YouTube metadata fetch. 2s timeout — title is optional input
// to the speaker registry, so swallow failures (registry falls back to
// host-roster + transcript scan).

import { spawn } from 'child_process';

const TITLE_FETCH_TIMEOUT_MS = 2_000;

export async function fetchYouTubeTitle(url: string): Promise<string | null> {
  return new Promise((resolveFn) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolveFn(v);
    };
    const ytdlp = spawn('yt-dlp', ['--print', '%(title)s', '--skip-download', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    ytdlp.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    ytdlp.on('error', () => finish(null));
    ytdlp.on('exit', (code) => {
      if (code === 0) {
        const title = stdout.trim().split('\n')[0] || '';
        finish(title || null);
      } else {
        finish(null);
      }
    });
    setTimeout(() => {
      try {
        ytdlp.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish(null);
    }, TITLE_FETCH_TIMEOUT_MS);
  });
}
