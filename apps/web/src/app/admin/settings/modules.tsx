'use client';
import { Alert, Badge, Card } from '@meridian/ui';
import Link from 'next/link';
import { post, useAction, useApi } from '@/lib/api';

interface Modules { fiberCoverage: { enabled: boolean; configured: boolean; host: string | null } }

/** Settings → Modules: optional parts of Meridian that are deployed separately and can be switched off without touching the rest. */
export function ModulesSettings() {
  const m = useApi<Modules>('/settings/modules');
  const act = useAction(async () => { await m.reload(); });
  if (m.error) return <Alert>{m.error}</Alert>;
  if (!m.data) return null;
  const f = m.data.fiberCoverage;
  const toggle = () => {
    if (f.enabled && !confirm('Switch fibre coverage off? The coverage check, fibre installation steps and fixed-broadband plans disappear from ordering and the store-front until you switch it on again.')) return;
    void act.run(() => post('/settings/modules', { fiberCoverage: { enabled: !f.enabled } }), f.enabled ? 'Fibre coverage is off.' : 'Fibre coverage is on.');
  };
  return (
    <div className="space-y-5">
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-title3 font-semibold">Fibre coverage and serviceability</h2>
            <p className="mt-1 text-subhead text-label2">Checks whether fibre reaches an address while an order is taken, shows which network serves it and at what speeds, and holds a port for the customer while they check out. It is a separate service (<code>apps/fiber-coverage</code>) with its own admin hub for network planning.</p>
            <ul className="mt-3 space-y-1 text-subhead">
              <li><strong>On:</strong> ordering and the store-front show the coverage check when a fibre plan is chosen, and fibre plans are for sale.</li>
              <li><strong>Off:</strong> the coverage check, fibre installation scheduling and fixed-broadband plans are hidden. Nothing else changes, and orders already placed are untouched.</li>
            </ul>
            <p className="mt-3 text-subhead">
              Service: {f.configured ? <Badge tone="success">Connected to {f.host}</Badge> : <Badge tone="warning">Not connected</Badge>}
              {!f.configured && <span className="ml-2 text-label2">Set <code>MERIDIAN_FIBER_URL</code> and <code>MERIDIAN_FIBER_API_KEY</code> on this deployment (a key with the fibre scope from the service’s hub). Until then fibre plans can be sold but the coverage check is unavailable.</span>}
            </p>
            <p className="mt-2 text-footnote text-label2">Setup and deployment: <Link href="/admin/integrations?section=field&item=fiber-coverage" className="text-accent">Integration → Fibre coverage</Link> · docs/FIBER_COVERAGE.md</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'On' : 'Off'}</Badge>
            <button type="button" role="switch" aria-checked={f.enabled} aria-label="Fibre coverage module" disabled={act.busy} onClick={toggle}
              className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition ${f.enabled ? 'bg-success' : 'bg-label3/40'} disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
              <span className={`inline-block h-6 w-6 rounded-full bg-white shadow transition ${f.enabled ? 'translate-x-7' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
