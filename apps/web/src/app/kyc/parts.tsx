'use client';
import { Badge } from '@meridian/ui';
import { dt, label } from '@/lib/format';
import { RISK_TONE } from './flags';
import { dueText, initials } from './view';

export const RiskBadge = ({ risk }: { risk?: string | null }) => (risk ? <Badge tone={RISK_TONE[risk] ?? 'neutral'}>{label(risk)} risk</Badge> : null);

/** Avatar initials and a name: "You" is highlighted, nobody is muted. */
export function Assignee({ username, name, me, source }: { username: string | null; name?: string | null; me?: string; source?: string | null }) {
  if (!username) return <span className="text-label2">Unassigned</span>;
  const you = username === me;
  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <span aria-hidden className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-caption font-semibold ${you ? 'bg-accent text-accent-fg' : 'bg-label/10 text-label2'}`}>{initials(name || username)}</span>
      <span className={`truncate ${you ? 'font-semibold text-accent' : ''}`}>{you ? 'You' : name || username}{source === 'AUTO' && <span className="sr-only"> (assigned automatically)</span>}</span>
    </span>
  );
}

/** How long a case has waited and when it is due. */
export function Waiting({ submittedAt, dueAt, overdue, done }: { submittedAt?: string | null; dueAt?: string | null; overdue?: boolean; done?: boolean }) {
  const due = done ? null : dueText(dueAt);
  return (
    <span className="block">
      <span className="block">{dt(submittedAt)}</span>
      {due && <span className={`block whitespace-nowrap text-caption ${due.overdue || overdue ? 'font-medium text-danger' : 'text-label2'}`}>{due.overdue || overdue ? `Overdue${due.overdue && due.text !== 'overdue' ? ` ${due.text.replace('overdue ', '')}` : ''}` : `Due: ${due.text}`}</span>}
    </span>
  );
}
