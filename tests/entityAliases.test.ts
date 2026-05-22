import assert from 'node:assert/strict';
import { entityAliases, normalizeEntities } from '../src/server/entityAliases.js';

for (const [alias, canonical] of entityAliases) {
  assert.equal(
    normalizeEntities(alias),
    canonical,
    `expected seed alias "${alias}" to normalize to "${canonical}"`
  );
}

assert.equal(normalizeEntities('wade raised a new round'), 'Wayve raised a new round');
assert.equal(normalizeEntities('WADE raised a new round'), 'WAYVE raised a new round');
assert.equal(normalizeEntities('open ai launched a model'), 'OpenAI launched a model');
assert.equal(normalizeEntities('OPEN AI launched a model'), 'OPENAI launched a model');

const unchanged = 'Stripe and Databricks discussed enterprise AI.';
assert.equal(normalizeEntities(unchanged), unchanged);

assert.equal(
  normalizeEntities('Wade competes with Wade in autonomous driving.'),
  'Wayve competes with Wayve in autonomous driving.'
);

assert.equal(
  normalizeEntities('Wade, Wobby, and Chat GPT were mentioned.'),
  'Wayve, Waabi, and ChatGPT were mentioned.'
);

assert.equal(
  normalizeEntities('The wadeable river is unrelated to Wade.'),
  'The wadeable river is unrelated to Wayve.'
);

console.log('entityAliases tests passed');

