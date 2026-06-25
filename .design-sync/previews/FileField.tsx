import * as React from 'react';
import { FileField } from '@skaly/web';

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

const noop = () => {};
// ~240 KB so the chip shows a realistic size.
const sampleCv = new File([new Uint8Array(240 * 1024)], 'jane-doe-cv.pdf', {
  type: 'application/pdf',
});

export function Empty() {
  return (
    <Frame>
      <FileField
        id="cv-empty"
        label="CV (optional)"
        value={null}
        onChange={noop}
        hint="PDF, DOC, or DOCX — up to 5 MB."
      />
    </Frame>
  );
}

export function Selected() {
  return (
    <Frame>
      <FileField id="cv-selected" label="CV (optional)" value={sampleCv} onChange={noop} />
    </Frame>
  );
}

export function WithError() {
  return (
    <Frame>
      <FileField
        id="cv-error"
        label="CV (optional)"
        value={null}
        onChange={noop}
        error="CV must be 5 MB or smaller."
      />
    </Frame>
  );
}
