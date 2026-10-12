'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { STEP_HINT, STEP_TITLE, type StepId } from './wizard-types';

/**
 * Where you are in the flow. On a wide screen every step is named and finished steps can be revisited; on a phone it is "Step 3 of 7" with a bar.
 * Moving forward is the primary action; going back never loses what was chosen.
 */
export function Stepper({ steps, index, onGo }: { steps: StepId[]; index: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="Order steps" className="mb-6">
      <p className="text-footnote font-medium text-label2 sm:hidden">Step {index + 1} of {steps.length} · <span className="text-label">{STEP_TITLE[steps[index]!]}</span></p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-separator sm:hidden" aria-hidden><div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]" style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
      <ol className="hidden items-center gap-1 sm:flex">
        {steps.map((s, i) => {
          const done = i < index, here = i === index;
          return (
            <li key={s} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span aria-hidden className={`h-px w-4 lg:w-8 ${done || here ? 'bg-accent' : 'bg-separator'}`} />}
              <button type="button" onClick={() => done && onGo(i)} disabled={!done} aria-current={here ? 'step' : undefined}
                className={`flex min-h-[36px] items-center gap-2 rounded-full pl-1 pr-3 text-subhead transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${here ? 'bg-accent/12 font-semibold text-accent' : done ? 'text-label hover:bg-surface2' : 'text-label2'}`}>
                <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-caption font-semibold ${here ? 'bg-accent text-accent-fg' : done ? 'bg-accent/15 text-accent' : 'bg-surface2 text-label2'}`}>{done ? '✓' : i + 1}</span>
                <span className={`truncate ${here ? 'inline' : 'hidden 2xl:inline'}`}>{STEP_TITLE[s]}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** One step's content: a title and a line of guidance, entering from the side it was reached from, focus moved to the heading for keyboards and screen readers. */
export function StepFrame({ id, direction, children }: { id: StepId; direction: 'fwd' | 'back'; children: ReactNode }) {
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => { h.current?.focus({ preventScroll: true }); }, [id]);
  return (
    <section key={id} aria-labelledby="step-title" className={direction === 'fwd' ? 'push-fwd' : 'push-back'}>
      <h2 id="step-title" ref={h} tabIndex={-1} className="text-title1 font-bold tracking-tight outline-none sm:text-large-title">{STEP_TITLE[id]}</h2>
      <p className="mb-5 mt-1 text-body text-label2">{STEP_HINT[id]}</p>
      {children}
    </section>
  );
}

export const Section = ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) => (
  <section className="mt-6 first:mt-0">
    <div className="mb-2 flex items-end justify-between gap-3 px-1"><h3 className="text-footnote font-semibold uppercase tracking-wide text-label2">{title}</h3>{action}</div>
    {children}
  </section>
);

export const Row = ({ k, v, strong }: { k: ReactNode; v: ReactNode; strong?: boolean }) => (
  <div className={`flex items-start justify-between gap-4 py-1.5 text-subhead ${strong ? 'font-semibold' : ''}`}><dt className={strong ? '' : 'text-label2'}>{k}</dt><dd className="text-right tabular-nums">{v}</dd></div>
);
