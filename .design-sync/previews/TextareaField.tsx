import * as React from 'react';
import { TextareaField } from '@skaly/web';

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

export function Empty() {
  return (
    <Frame>
      <TextareaField
        label="Message (optional)"
        placeholder="Anything we should know about your request?"
        count={{ current: 0, max: 500 }}
      />
    </Frame>
  );
}

export function WithContent() {
  const text =
    'I lead the content team at Acme and would love a manager seat to run our shoot pipeline.';
  return (
    <Frame>
      <TextareaField
        label="Message (optional)"
        defaultValue={text}
        count={{ current: text.length, max: 500 }}
      />
    </Frame>
  );
}
