import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE shoot_schedules (
      id              UUID        NOT NULL DEFAULT gen_random_uuid(),
      period          CHAR(7)     NOT NULL REFERENCES months(period),
      client_id       UUID        NOT NULL REFERENCES clients(id),
      slot_index      SMALLINT    NOT NULL,
      slot_status     VARCHAR(15) NOT NULL DEFAULT 'Unset',
      slot_date       DATE,
      pieces_expected INTEGER     NOT NULL DEFAULT 1,
      freelancer_id   UUID        NULL REFERENCES staff(id),
      updated_by      UUID        REFERENCES staff(id),
      updated_at      TIMESTAMPTZ,
      CONSTRAINT shoot_schedules_pkey     PRIMARY KEY (id),
      CONSTRAINT shoot_schedules_unique   UNIQUE (period, client_id, slot_index),
      CONSTRAINT shoot_schedules_slot_idx CHECK (slot_index >= 1),
      CONSTRAINT shoot_schedules_status   CHECK (slot_status IN ('Unset','Scheduled','Confirmed','Completed'))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_shoots_period_client ON shoot_schedules(period, client_id)`.execute(db);
  await sql`CREATE INDEX idx_shoots_freelancer    ON shoot_schedules(freelancer_id) WHERE freelancer_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_shoots_freelancer`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_shoots_period_client`.execute(db);
  await sql`DROP TABLE IF EXISTS shoot_schedules`.execute(db);
}
