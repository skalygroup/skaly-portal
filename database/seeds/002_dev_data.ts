if (process.env.NODE_ENV === 'production') { 
  console.log('Skipping dev seed — production'); 
  process.exit(0); 
}

import { Kysely } from 'kysely';

export async function seedDevData(db: Kysely<any>) {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const label = now.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  // 1. Current month
  await db
    .insertInto('months')
    .values({
      period,
      label,
      locked: false,
    })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  // 2. Staff (4 roles)
  await db
    .insertInto('staff')
    .values([
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Admin User',
        email: 'admin@test.skaly.in',
        role: 'admin',
        active: true,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Manager User',
        email: 'manager@test.skaly.in',
        role: 'manager',
        active: true,
      },
      {
        id: '33333333-3333-3333-3333-333333333333',
        name: 'Team Member',
        email: 'team@test.skaly.in',
        role: 'team_member',
        active: true,
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        name: 'Freelancer User',
        email: 'freelancer@test.skaly.in',
        role: 'freelancer',
        active: true,
      },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // 3. Clients
  await db
    .insertInto('clients')
    .values([
      {
        id: 'c1111111-1111-1111-1111-111111111111',
        name: 'Naaz Furniture',
        shoot_slots_per_month: 4,
        pieces_per_visit: 2,
        is_internal: false,
        active: true,
      },
      {
        id: 'c2222222-2222-2222-2222-222222222222',
        name: 'Hyatt Hotels',
        shoot_slots_per_month: 6,
        pieces_per_visit: 3,
        is_internal: false,
        active: true,
      },
      {
        id: 'c3333333-3333-3333-3333-333333333333',
        name: 'Skaly Internal',
        shoot_slots_per_month: 2,
        pieces_per_visit: 1,
        is_internal: true,
        active: true,
      },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}
