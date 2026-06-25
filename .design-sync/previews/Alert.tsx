import * as React from 'react';
import { Alert, AlertTitle, AlertDescription } from '@skaly/web';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark"
      style={{
        background: '#141417',
        padding: 24,
        borderRadius: 12,
        display: 'grid',
        gap: 16,
        maxWidth: 460,
      }}
    >
      {children}
    </div>
  );
}

export function Default() {
  return (
    <Frame>
      <Alert>
        <CheckCircle2 />
        <AlertTitle>Shoot scheduled</AlertTitle>
        <AlertDescription>
          The Friday content shoot is confirmed for 10:00 AM at Studio 2.
        </AlertDescription>
      </Alert>
    </Frame>
  );
}

export function Destructive() {
  return (
    <Frame>
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Upload failed</AlertTitle>
        <AlertDescription>
          We couldn&apos;t process 2 of the 8 files. Check the format and try again.
        </AlertDescription>
      </Alert>
    </Frame>
  );
}

export function TitleOnly() {
  return (
    <Frame>
      <Alert>
        <CheckCircle2 />
        <AlertTitle>All attendance synced for today.</AlertTitle>
      </Alert>
    </Frame>
  );
}
