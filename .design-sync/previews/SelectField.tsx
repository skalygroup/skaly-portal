import * as React from 'react';
import { SelectField } from '@skaly/web';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark"
      style={{ background: '#141417', padding: 24, borderRadius: 12, maxWidth: 380 }}
    >
      {children}
    </div>
  );
}

const ROLES = [
  { value: 'team_member', label: 'Team member' },
  { value: 'manager', label: 'Manager' },
  { value: 'freelancer', label: 'Freelancer' },
];

export function Default() {
  return (
    <Frame>
      <SelectField label="Role requested" options={ROLES} defaultValue="team_member" />
    </Frame>
  );
}

export function WithError() {
  return (
    <Frame>
      <SelectField label="Role requested" options={ROLES} error="Choose a role to continue" />
    </Frame>
  );
}
