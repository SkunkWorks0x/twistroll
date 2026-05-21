import * as lancedb from '@lancedb/lancedb';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const TABLE_NAME = 'episodes';
const TARGETS = [
  ['active', resolve(ROOT, 'data/lance-db')],
  ['backup', resolve(ROOT, 'data/lance-db_backup_20260506_001635')],
];

function vectorDimFromField(field) {
  const type = field.type;
  return type?.listSize ?? type?.list_size ?? type?.children?.[0]?.length ?? null;
}

function describeField(field) {
  const type = field.type;
  return {
    name: field.name,
    nullable: field.nullable,
    type: String(type),
    typeClass: type?.constructor?.name ?? null,
    vectorDim: vectorDimFromField(field),
  };
}

async function trySearch(tbl, dim) {
  const probe = new Array(dim).fill(0);
  try {
    await tbl.search(probe).limit(1).toArray();
    return 'ok';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function inspect(label, dbPath) {
  console.log(`\n=== ${label}: ${dbPath} ===`);
  const db = await lancedb.connect(dbPath);
  const names = await db.tableNames();
  console.log(`tables: ${names.join(', ') || '(none)'}`);
  if (!names.includes(TABLE_NAME)) {
    console.log(`missing table: ${TABLE_NAME}`);
    db.close?.();
    return;
  }

  const tbl = await db.openTable(TABLE_NAME);
  console.log(`display: ${tbl.display()}`);
  console.log(`rows: ${await tbl.countRows()}`);

  const schema = await tbl.schema();
  console.log('schema fields:');
  for (const field of schema.fields) {
    const d = describeField(field);
    console.log(`- ${d.name}: ${d.type} class=${d.typeClass} nullable=${d.nullable}${d.vectorDim ? ` dim=${d.vectorDim}` : ''}`);
  }

  const vectorField = schema.fields.find((f) => f.name === 'vector');
  console.log(`schema vector dim: ${vectorField ? vectorDimFromField(vectorField) : '(no vector field)'}`);

  const sample = await tbl.query().select(['id', 'vector']).limit(1).toArray();
  const vector = sample[0]?.vector;
  console.log(`sample id: ${sample[0]?.id ?? '(none)'}`);
  console.log(`sample vector JS type: ${vector?.constructor?.name ?? typeof vector}`);
  console.log(`sample vector length: ${vector ? Array.from(vector).length : '(none)'}`);

  console.log(`search with 768 dims: ${await trySearch(tbl, 768)}`);
  console.log(`search with 1536 dims: ${await trySearch(tbl, 1536)}`);

  tbl.close?.();
  db.close?.();
}

for (const [label, dbPath] of TARGETS) {
  await inspect(label, dbPath);
}
