import { Kysely, sql } from 'kysely';

/**
 * B-01 enforcement: make AuditService.log() the ONLY write path into
 * audit_log.
 *
 * Migration 026 made audit_log append-only (REVOKE UPDATE, DELETE) but still
 * left INSERT granted to skaly_app via the blanket
 * `GRANT SELECT, INSERT, UPDATE ON ALL TABLES`. That means any code path in
 * the API — not just AuditService.log() — can write arbitrary audit rows,
 * which violates the B-01 contract in docs/audit.
 *
 * The fix is the canonical Postgres mechanism: a SECURITY DEFINER function.
 * The function runs with its owner's privileges (skaly, the superuser, which
 * retains INSERT on audit_log) regardless of who calls it. We then REVOKE
 * INSERT from skaly_app on the table and GRANT EXECUTE on the function, so
 * the application can only ever insert audit rows by calling
 * audit_log_insert().
 *
 * SECURITY: the function pins `SET search_path = pg_catalog, public` with
 * pg_catalog FIRST. Without a fixed search_path, an attacker who controls a
 * schema earlier in the path could shadow built-ins (e.g. gen_random_uuid,
 * now) with malicious functions and escalate via the definer's privileges.
 *
 * NOTE: Like 026, this runs as the database SUPERUSER. The role being
 * granted/revoked is `skaly_app`, the application connection user.
 *
 * Do NOT modify 026 — the entire fix lives here in 027.
 */

const APP_ROLE = 'skaly_app';

export async function up(db: Kysely<any>): Promise<void> {
  // ─── The single sanctioned write path into audit_log ───────────────────
  // Required params first, optional params (DEFAULT) last — Postgres requires
  // this ordering. SECURITY DEFINER so it inserts with the owner's INSERT
  // privilege even after we revoke INSERT from the caller below.
  await sql`
    CREATE OR REPLACE FUNCTION audit_log_insert(
      p_staff_id          UUID,
      p_table_name        VARCHAR(50),
      p_action            VARCHAR(15),
      p_record_id         UUID        DEFAULT NULL,
      p_old_value         JSONB       DEFAULT NULL,
      p_new_value         JSONB       DEFAULT NULL,
      p_changed_by_source VARCHAR(10) DEFAULT 'user',
      p_ip_address        INET        DEFAULT NULL
    )
    RETURNS UUID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      v_id UUID;
    BEGIN
      INSERT INTO audit_log (
        id,
        staff_id,
        changed_by_source,
        table_name,
        record_id,
        action,
        old_value,
        new_value,
        ip_address,
        created_at
      ) VALUES (
        gen_random_uuid(),
        p_staff_id,
        p_changed_by_source,
        p_table_name,
        p_record_id,
        p_action,
        p_old_value,
        p_new_value,
        p_ip_address,
        now()
      )
      RETURNING id INTO v_id;

      RETURN v_id;
    END;
    $$
  `.execute(db);

  // ─── CRITICAL: lock down direct INSERT, route all writes through the fn ──
  // After this, skaly_app cannot INSERT into audit_log directly; it can only
  // call audit_log_insert(), which runs as the definer (skaly).
  await sql`REVOKE INSERT ON audit_log FROM ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`
    GRANT EXECUTE ON FUNCTION audit_log_insert(UUID, VARCHAR, VARCHAR, UUID, JSONB, JSONB, VARCHAR, INET)
    TO ${sql.raw(APP_ROLE)}
  `.execute(db);

  await sql`
    COMMENT ON FUNCTION audit_log_insert(UUID, VARCHAR, VARCHAR, UUID, JSONB, JSONB, VARCHAR, INET) IS
      'B-01 enforcement: the ONLY sanctioned write path into audit_log. SECURITY DEFINER function owned by the superuser; skaly_app has INSERT revoked on the table and may only insert audit rows by calling this function (via AuditService.log()). search_path is pinned to pg_catalog,public to prevent schema-hijacking privilege escalation. See docs/audit B-01.'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse everything: drop EXECUTE, restore direct INSERT, drop the fn.
  await sql`
    REVOKE EXECUTE ON FUNCTION audit_log_insert(UUID, VARCHAR, VARCHAR, UUID, JSONB, JSONB, VARCHAR, INET)
    FROM ${sql.raw(APP_ROLE)}
  `.execute(db);
  await sql`GRANT INSERT ON audit_log TO ${sql.raw(APP_ROLE)}`.execute(db);
  await sql`DROP FUNCTION IF EXISTS audit_log_insert(UUID, VARCHAR, VARCHAR, UUID, JSONB, JSONB, VARCHAR, INET)`.execute(db);
}
