// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../utils/logger.js';
import type { PostgresQueryable } from './utils.js';

export const SERVER_POSTGRES_SCHEMA_VERSION = 1;

// Phase 1b (cmem-sdk rename): the TS constant is renamed but the table-name
// strings remain on `server_beta_*` since they are persisted DDL identifiers.
// Plan §1d will migrate the table names in a coordinated DDL change.
export const SERVER_POSTGRES_TABLES = [
  'server_beta_schema_migrations',
  'teams',
  'projects',
  'team_members',
  'api_keys',
  'audit_log',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
  'observation_sources',
  'observation_generation_job_events',
  'usage_events',
  'rate_limit_counters'
] as const;

export async function bootstrapServerPostgresSchema(client: PostgresQueryable): Promise<void> {
  if (isPostgresPool(client)) {
    const poolClient = await client.connect();
    try {
      await applySchema(poolClient, client);
    } finally {
      poolClient.release();
    }
  } else {
    await applySchema(client, client);
  }
}

// One connection for the whole bootstrap: BEGIN and COMMIT sent through a
// pool could each land on a different connection.
async function applySchema(client: PostgresQueryable, owner: PostgresQueryable): Promise<void> {
  await client.query('BEGIN');
  try {
    await applyPhase1Migration(client);
    await applyBm25Index(client);
    await detectBm25Index(client, owner);
    await client.query('COMMIT');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('SYSTEM', 'postgres schema bootstrap failed, rolling back', {}, err);
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applyPhase1Migration(client: PostgresQueryable): Promise<void> {
  await client.query(PHASE_1_SCHEMA_SQL);
  await client.query(
    `
      INSERT INTO server_beta_schema_migrations (version, description)
      VALUES ($1, $2)
      ON CONFLICT (version) DO NOTHING
    `,
    [SERVER_POSTGRES_SCHEMA_VERSION, 'phase 1 postgres observation storage foundation']
  );
}

export const BM25_INDEX_NAME = 'idx_observations_content_bm25';

// Keyword search ranks by bm25 when the pg_textsearch extension provides a
// bm25 index over observation content, and by ts_rank otherwise. Stock
// postgres images do not ship it, and it needs shared_preload_libraries, so
// where it is not installable no index is created and search keeps ts_rank.
// The index is not a numbered migration: whether it can exist depends on the
// extension, so every bootstrap reconciles it.
async function applyBm25Index(client: PostgresQueryable): Promise<void> {
  const available = await client.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'pg_textsearch'`
  );
  if (available.rows.length === 0) return;
  // pg_textsearch is not a trusted extension, and it refuses to be created
  // unless preloaded: either way the role boots with ts_rank ranking.
  const installed = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch'`);
  if (installed.rows.length === 0) {
    await client.query('SAVEPOINT create_pg_textsearch');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_textsearch');
      await client.query('RELEASE SAVEPOINT create_pg_textsearch');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT create_pg_textsearch');
      logger.warn('SYSTEM', 'pg_textsearch could not be created; keyword search ranks by ts_rank', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }
  if (!(await isBm25Loaded(client))) {
    logger.warn('SYSTEM', 'pg_textsearch is installed but not in shared_preload_libraries; keyword search ranks by ts_rank');
    return;
  }
  // Installed earlier into a schema outside this connection's search_path,
  // its access method still works but its operator cannot be named here.
  const visible = await client.query<{ visible: boolean }>(
    `SELECT to_regtype('bm25query') IS NOT NULL AS visible`
  );
  if (visible.rows[0]?.visible !== true) {
    logger.warn('SYSTEM', 'pg_textsearch is installed in a schema outside the search_path; keyword search ranks by ts_rank');
    return;
  }
  // Tokenized as content_search is, so a row the bm25 index scores is a row
  // the english tsvector matches.
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${BM25_INDEX_NAME} ON observations USING bm25 (content) WITH (text_config = 'english')`
  );
}

const BM25_LOADED_SQL =
  `'pg_textsearch' = ANY(string_to_array(replace(current_setting('shared_preload_libraries'), ' ', ''), ','))`;

async function isBm25Loaded(client: PostgresQueryable): Promise<boolean> {
  const result = await client.query<{ loaded: boolean }>(`SELECT ${BM25_LOADED_SQL} AS loaded`);
  return result.rows[0]?.loaded === true;
}

// Whether search() ranks by bm25, per pool or client, decided at startup by
// detectBm25Index so a search runs no extra query to find out.
const bm25IndexInUse = new WeakMap<PostgresQueryable, boolean>();

/**
 * Decides, once, whether keyword search through this pool or client ranks by
 * bm25: the index exists in its search_path, its library is loaded, and it is
 * the only bm25 index on observations (a query naming one index fails if the
 * planner scans another). Bootstrap calls it; a server started without
 * bootstrap calls it directly. Queried through `client`, recorded for `owner`
 * (a pool, when `client` is one of its connections).
 */
export async function detectBm25Index(client: PostgresQueryable, owner: PostgresQueryable = client): Promise<boolean> {
  const result = await client.query<{ present: boolean; others: number }>(
    `SELECT to_regclass($1) IS NOT NULL AND ${BM25_LOADED_SQL} AS present,
       (SELECT count(*)::int FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_am a ON a.oid = c.relam
        WHERE a.amname = 'bm25' AND i.indrelid = to_regclass('observations')
          AND i.indexrelid IS DISTINCT FROM to_regclass($1)) AS others`,
    [BM25_INDEX_NAME]
  );
  const row = result.rows[0];
  if (row?.present === true && row.others > 0) {
    logger.warn('SYSTEM', 'observations has another bm25 index besides the one claude-mem creates; keyword search ranks by ts_rank');
  }
  const inUse = row?.present === true && row.others === 0;
  bm25IndexInUse.set(owner, inUse);
  logger.info('SYSTEM', `keyword search ranks by ${inUse ? 'bm25 (pg_textsearch)' : 'ts_rank'}`);
  return inUse;
}

/** What detectBm25Index decided for this pool or client; ts_rank if it never ran. */
export function usesBm25Index(client: PostgresQueryable): boolean {
  return bm25IndexInUse.get(client) === true;
}

interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresQueryable & { release(): void }>;
}

function isPostgresPool(client: PostgresQueryable): client is PostgresPoolLike {
  const candidate = client as {
    connect?: unknown;
    release?: unknown;
    totalCount?: unknown;
    idleCount?: unknown;
    waitingCount?: unknown;
  };
  return (
    typeof candidate.connect === 'function'
    && typeof candidate.release !== 'function'
    && typeof candidate.totalCount === 'number'
    && typeof candidate.idleCount === 'number'
    && typeof candidate.waitingCount === 'number'
  );
}

const PHASE_1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS server_beta_schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, team_id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (project_id IS NULL OR team_id IS NOT NULL),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_id TEXT,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (project_id IS NULL OR team_id IS NOT NULL),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS server_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  external_session_id TEXT,
  idempotency_key TEXT,
  content_session_id TEXT,
  agent_id TEXT,
  agent_type TEXT,
  platform_source TEXT,
  generation_status TEXT NOT NULL DEFAULT 'idle',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  last_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  source_adapter TEXT NOT NULL,
  source_event_id TEXT,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  UNIQUE (id, project_id, team_id),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observation_generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex')),
  source_id TEXT NOT NULL,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  bullmq_job_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_error JSONB,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type = 'session_summary' AND agent_event_id IS NULL AND server_session_id IS NOT NULL AND source_id = server_session_id)
    OR
    (source_type = 'observation_reindex' AND agent_event_id IS NULL)
  ),
  FOREIGN KEY (agent_event_id, project_id, team_id) REFERENCES agent_events(id, project_id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'observation',
  content TEXT NOT NULL,
  content_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  generation_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding JSONB,
  created_by_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observation_sources (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  generation_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex', 'manual')),
  source_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (observation_id, source_type, source_id),
  UNIQUE (source_type, source_id, generation_job_id, observation_id),
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type <> 'agent_event' AND agent_event_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS observation_generation_job_events (
  id TEXT PRIMARY KEY,
  generation_job_id TEXT NOT NULL REFERENCES observation_generation_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('queued', 'enqueued', 'processing', 'retry_scheduled', 'completed', 'failed', 'cancelled')),
  status_after TEXT NOT NULL CHECK (status_after IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_project_session ON agent_events(project_id, server_session_id, occurred_at);
ALTER TABLE server_sessions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE server_sessions DROP CONSTRAINT IF EXISTS server_sessions_project_id_external_session_id_key;
-- #2560 — platform_source on agent_events (consistent with server_sessions and
-- the plan-09 scoping): which platform produced the event (claude-code,
-- opencode, cursor, ...). Idempotent so an existing DB upgrades in place.
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS platform_source TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_events_platform_source
  ON agent_events(team_id, project_id, platform_source, occurred_at)
  WHERE platform_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_sessions_platform_source
  ON server_sessions(team_id, project_id, platform_source, started_at)
  WHERE platform_source IS NOT NULL;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS content_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_generation_key_key;
ALTER TABLE observation_generation_jobs DROP CONSTRAINT IF EXISTS observation_generation_jobs_source_type_source_id_job_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_project_idempotency
  ON server_sessions(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_external_session_legacy
  ON server_sessions(project_id, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_external_session_platform
  ON server_sessions(project_id, platform_source, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NOT NULL;
DROP INDEX IF EXISTS idx_server_sessions_content_session;
-- Supports platform-aware session linkage lookup on the /v1/events ingest path.
CREATE INDEX IF NOT EXISTS idx_server_sessions_content_session_platform
  ON server_sessions(team_id, project_id, platform_source, content_session_id, started_at DESC)
  WHERE content_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_generation_key_scope
  ON observations(team_id, project_id, generation_key)
  WHERE generation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_jobs_source_scope
  ON observation_generation_jobs(team_id, project_id, source_type, source_id, job_type);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_events_team_project ON agent_events(team_id, project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_observations_project_session ON observations(project_id, server_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_team_project ON observations(team_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_content_search ON observations USING GIN (content_search);
CREATE INDEX IF NOT EXISTS idx_observation_sources_event ON observation_sources(agent_event_id);
CREATE INDEX IF NOT EXISTS idx_observation_sources_source ON observation_sources(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_status_next_attempt ON observation_generation_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_team_project ON observation_generation_jobs(team_id, project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_event ON observation_generation_jobs(agent_event_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_source ON observation_generation_jobs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_processing_locked_at ON observation_generation_jobs(locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_observation_job_events_job_created ON observation_generation_job_events(generation_job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_scope_created ON audit_log(project_id, team_id, created_at);

-- Usage metering: append-only per-team usage, aggregated for quotas + billing.
-- kind is open-ended ('request', 'tokens_in', 'tokens_out', 'observation', ...).
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_team_created ON usage_events(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_team_kind_created ON usage_events(team_id, kind, created_at);

-- Fixed-window rate-limit counters. subject_id is the api key id (per-key limit).
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  subject_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters(window_start);
`;
