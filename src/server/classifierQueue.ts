import { classifyWindow, SpeakerMap } from './classifier.js';
import type { TranscriptSegment, ClaimClassification } from '../shared/types.js';

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const MAX_CONCURRENCY = envInt('CLASSIFIER_MAX_CONCURRENCY', 2);
const MAX_PENDING = envInt('CLASSIFIER_MAX_PENDING', 10);

export interface ClassifierTask {
  window: TranscriptSegment[];
  prior: TranscriptSegment[];
  speakerMap: SpeakerMap;
  segmentId: string;
  enqueuedAt: number;
}

interface ClassifierTaskResult {
  classification: ClaimClassification;
  latencyMs: number;
  task: ClassifierTask;
}

type ClassifierResultHandler = (result: ClassifierTaskResult) => void | Promise<void>;
type ClassifierErrorHandler = (err: unknown, task: ClassifierTask) => void;

let resultHandler: ClassifierResultHandler | null = null;
let errorHandler: ClassifierErrorHandler | null = null;

const pending: ClassifierTask[] = [];
let activeCount = 0;
let droppedByBackpressure = 0;

export function setClassifierHandlers(
  onResult: ClassifierResultHandler,
  onError: ClassifierErrorHandler
): void {
  resultHandler = onResult;
  errorHandler = onError;
}

export function enqueueClassifierTask(task: ClassifierTask): void {
  if (activeCount < MAX_CONCURRENCY) {
    runTask(task);
    return;
  }
  if (MAX_PENDING <= 0) {
    // Pending disabled — drop newcomer rather than corrupt queue with a
    // doomed shift() on an empty array.
    droppedByBackpressure++;
    console.warn(
      `[CLASSIFIER-QUEUE] pending disabled (MAX_PENDING=${MAX_PENDING}) — dropped segmentId=${task.segmentId}`
    );
    return;
  }
  if (pending.length >= MAX_PENDING) {
    const evicted = pending.shift()!;
    droppedByBackpressure++;
    console.warn(
      `[CLASSIFIER-QUEUE] pending full (${MAX_PENDING}) — dropped oldest segmentId=${evicted.segmentId}`
    );
  }
  pending.push(task);
}

function runTask(task: ClassifierTask): void {
  activeCount++;
  classifyWindow(task.window, task.prior, task.speakerMap)
    .then((res) => {
      if (resultHandler) return resultHandler({ ...res, task });
    })
    .catch((err: unknown) => {
      if (errorHandler) errorHandler(err, task);
    })
    .finally(() => {
      activeCount--;
      drainPending();
    });
}

function drainPending(): void {
  while (activeCount < MAX_CONCURRENCY && pending.length > 0) {
    const next = pending.shift();
    if (next) runTask(next);
  }
}

export function classifierQueueStats() {
  return {
    classifierActive: activeCount,
    classifierPending: pending.length,
    classifierDroppedByBackpressure: droppedByBackpressure,
    classifierMaxConcurrency: MAX_CONCURRENCY,
    classifierMaxPending: MAX_PENDING,
  };
}
