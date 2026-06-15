# EmptyState component

Standard empty-state UI used across every list, grid, and panel
that can be empty. Renders a Lucide icon, a title, an optional
description, and an optional action.

Located at: apps/web/src/components/empty-state.tsx

## Usage

Import the icon from lucide-react and the component from the
components folder:

    import { ListTodo } from 'lucide-react';
    import { EmptyState } from '@/components/empty-state';
    
    <EmptyState
      icon={ListTodo}
      title="No tasks yet"
      description="When tasks are assigned to you, they'll appear here."
    />

## Standard icon picks per module

- Attendance      CalendarClock      (Sprint 3)
- Tasks           ListTodo           (Sprint 4)
- Shoot Planner   Camera             (Sprint 5)
- Content Dropper Package            (Sprint 6)
- Content Calendar CalendarDays      (Sprint 7)
- Bot             Bot                (Sprint 8)
- Search          SearchX            (Sprint 9)
- Chat            MessageSquare      (Sprint 10)
- Notifications   Bell               (Sprint 10)
- Dashboard       LayoutDashboard    (Sprint 11)
- Reports         FileText           (Sprint 12)
- Comments        MessageCircle      (Sprint 12)
- 404 page        FileQuestion
- 403 forbidden   ShieldOff

## 404 page wiring

apps/web/src/app/not-found.tsx:

    import { FileQuestion } from 'lucide-react';
    import Link from 'next/link';
    import { Button } from '@/components/ui/button';
    import { EmptyState } from '@/components/empty-state';
    
    export default function NotFound() {
      return (
        <EmptyState
          icon={FileQuestion}
          title="Page not found"
          description="The page you're looking for doesn't exist or you don't have access."
          action={
            <Button asChild>
              <Link href="/">Back to dashboard</Link>
            </Button>
          }
        />
      );
    }
