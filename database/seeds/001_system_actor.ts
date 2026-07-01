import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { Kysely } from 'kysely';

export async function seedSystemActor(db: Kysely<any>) {
  await db
    .insertInto('staff')
    .values({
      id: SYSTEM_ACTOR_UUID,
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
