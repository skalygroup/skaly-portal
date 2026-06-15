import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE tasks (
      id              UUID        NOT NULL DEFAULT gen_random_uuid(),
      period          CHAR(7)     NOT NULL REFERENCES months(period),
      date            DATE        NOT NULL,
      client_id       UUID        REFERENCES clients(id),
      description     TEXT        NOT NULL,
      status          VARCHAR(20) NOT NULL DEFAULT 'To Do',
      priority        VARCHAR(10) NULL,
      dependency_id   UUID        REFERENCES tasks(id),
      remark          TEXT,
      deadline        DATE,
      result          TEXT,
      created_by      UUID        NOT NULL REFERENCES staff(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ,
      CONSTRAINT tasks_pkey            PRIMARY KEY (id),
      CONSTRAINT tasks_status_check    CHECK (status IN ('To Do','In Progress','Blocked','Done','Cancelled')),
      CONSTRAINT tasks_priority_check  CHECK (priority IN ('Low','Medium','High','Urgent') OR priority IS NULL),
      CONSTRAINT tasks_no_self_dep     CHECK (dependency_id IS DISTINCT FROM id)
    )
  `.execute(db);

  // Full-text search column (GENERATED ALWAYS — auto-maintained)
  await sql`
    ALTER TABLE tasks ADD COLUMN search_vector TSVECTOR
      GENERATED ALWAYS AS (
        to_tsvector('english', description || ' ' || COALESCE(result, '') || ' ' || COALESCE(remark, ''))
      ) STORED
  `.execute(db);

  await sql`CREATE INDEX idx_tasks_period_date   ON tasks(period, date)   WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX idx_tasks_period_status ON tasks(period, status) WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX idx_tasks_search        ON tasks USING GIN(search_vector)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_tasks_search`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_tasks_period_status`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_tasks_period_date`.execute(db);
  await sql`DROP TABLE IF EXISTS tasks`.execute(db);
}
