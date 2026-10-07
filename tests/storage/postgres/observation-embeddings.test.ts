import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  PostgresObservationRepository,
} from '../../../src/storage/postgres/index.js';
import {
  observationEmbeddingParts,
  PostgresObservationEmbeddingsRepository,
} from '../../../src/storage/postgres/observation-embeddings.js';
import { createIsolatedSchema, dropSchema } from '../../sdk/pg-isolation.js';

describe('observationEmbeddingParts', () => {
  it('splits an observation into narrative, legacy text and each fact, named like the Chroma ids', () => {
    const parts = observationEmbeddingParts('discovery', {
      title: 'T',
      narrative: 'the narrative',
      facts: ['fact a', '', 'fact c'],
      legacy: { text: 'legacy text' },
    }, 'content');
    expect(parts).toEqual([
      { part: 'narrative', text: 'the narrative' },
      { part: 'text', text: 'legacy text' },
      { part: 'fact_0', text: 'fact a' },
      { part: 'fact_2', text: 'fact c' },
    ]);
  });

  it('falls back to title and subtitle, ignoring the Untitled placeholder', () => {
    expect(observationEmbeddingParts('change', { title: 'A title', subtitle: 'sub' }, 'c'))
      .toEqual([{ part: 'title', text: 'A title\nsub' }]);
    expect(observationEmbeddingParts('change', { title: 'Untitled', subtitle: 'sub' }, 'c'))
      .toEqual([{ part: 'title', text: 'sub' }]);
  });

  it('embeds one part per summary field', () => {
    expect(observationEmbeddingParts('summary', {
      request: 'r', investigated: null, learned: 'l', next_steps: 'n',
    }, 'content')).toEqual([
      { part: 'request', text: 'r' },
      { part: 'learned', text: 'l' },
      { part: 'next_steps', text: 'n' },
    ]);
  });

  it('embeds the content of a row with no structured fields', () => {
    expect(observationEmbeddingParts('manual', {}, 'free text'))
      .toEqual([{ part: 'content', text: 'free text' }]);
  });
});

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

/** A unit vector along one axis, so nearness is exact and needs no model. */
function axis(index: number): Float32Array {
  const vector = new Float32Array(384);
  vector[index] = 1;
  return vector;
}

describe.skipIf(!testDatabaseUrl)('hybrid observation search', () => {
  let vectorAvailable = false;
  let schemaName: string;
  let pool: pg.Pool;
  let projectId: string;
  let teamId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // The extension lives in public, so each test schema reaches it through
    // its search_path, the way a deployment with the default path does.
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    try {
      const available = await admin.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
      if (available.rows.length > 0) {
        await admin.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
        vectorAvailable = true;
      }
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    if (!vectorAvailable) return;
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_vec_test');
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    await bootstrapServerPostgresSchema(pool);
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'project' });
    teamId = team.id;
    projectId = project.id;

    const embeddings = new PostgresObservationEmbeddingsRepository(pool);
    const rows: Array<[string, string, number]> = [
      ['indexer', 'The code-search indexer runs nightly on the build host.', 1],
      ['gateway', 'The gateway Worker moved to a custom domain.', 2],
      ['backup', 'Postgres is dumped before every schema change.', 3],
    ];
    for (const [key, content, axisIndex] of rows) {
      const observation = await storage.observations.create({ projectId, teamId, content, metadata: { narrative: content } });
      ids[key] = observation.id;
      await embeddings.upsert({
        observationId: observation.id,
        model: 'test',
        parts: [{ part: 'narrative', text: content }],
        vectors: [axis(axisIndex)],
      });
    }
  });

  afterEach(async () => {
    if (!vectorAvailable) return;
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
  });

  afterAll(() => {
    if (!vectorAvailable) console.warn('pgvector not installed in the test database; hybrid search tests did nothing');
  });

  it('finds an observation by meaning when no keyword matches', async () => {
    if (!vectorAvailable) return;
    const repo = new PostgresObservationRepository(pool);
    const query = 'which host builds the semantic code index';
    expect(await repo.search({ projectId, teamId, query })).toEqual([]);

    const results = await repo.search({ projectId, teamId, query, queryEmbedding: axis(1) });
    expect(results[0]?.id).toBe(ids.indexer);
  });

  it('ranks an observation found by both keyword and vector above one found by either', async () => {
    if (!vectorAvailable) return;
    const repo = new PostgresObservationRepository(pool);
    // "gateway" matches by keyword only; the vector points at the same row,
    // while "backup" is the second-nearest vector and matches no keyword.
    const nearGatewayThenBackup = axis(2);
    nearGatewayThenBackup[3] = 0.5;
    const results = await repo.search({ projectId, teamId, query: 'gateway', queryEmbedding: nearGatewayThenBackup });
    expect(results[0]?.id).toBe(ids.gateway);
    expect(results.map(o => o.id)).toContain(ids.backup);
  });

  it('deletes an observation\'s vectors with it', async () => {
    if (!vectorAvailable) return;
    await pool.query('DELETE FROM observations WHERE id = $1', [ids.indexer]);
    const remaining = await pool.query('SELECT count(*)::int AS n FROM observation_embeddings WHERE observation_id = $1', [ids.indexer]);
    expect(remaining.rows[0].n).toBe(0);
  });
});
