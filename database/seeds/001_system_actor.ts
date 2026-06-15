import { Kysely } from 'kysely';

export async function seedSystemActor(db: Kysely<any>) {
  await db
    .insertInto('staff')
    .values({
      id: '00000000-0000-0000-0000-000000000000',
      name: 'System',
      email: 'system@skaly.internal',
      role: 'admin',
      active: true,
      mfa_enrolled: true,
      supabase_uid: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}
