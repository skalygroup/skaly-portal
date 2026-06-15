import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE notifications (
      id          UUID          NOT NULL DEFAULT gen_random_uuid(),
      staff_id    UUID          NOT NULL REFERENCES staff(id),
      type        VARCHAR(40)   NOT NULL,
      title       VARCHAR(150)  NOT NULL,
      message     VARCHAR(500),
      payload     JSONB         NOT NULL DEFAULT '{}',
      is_read     BOOLEAN       NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT notifications_pkey       PRIMARY KEY (id),
      CONSTRAINT notifications_type_check CHECK (type IN (
        'month_ready','task_assigned','task_overdue','dependency_resolved',
        'shoot_confirmed','holiday_added','holiday_removed',
        'rollover_failed','rollover_success','rollover_view_refresh_failed',
        'new_comment','mention',
        'signup_request','signup_approved','signup_rejected',
        'client_updated','report_ready',
        'account_reactivated'
      ))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_notif_staff_unread ON notifications(staff_id, is_read, created_at DESC)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_notif_staff_unread`.execute(db);
  await sql`DROP TABLE IF EXISTS notifications`.execute(db);
}
