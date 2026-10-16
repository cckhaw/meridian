'use client';
import { Badge, Card, Empty, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { PENDING_VERIFICATION: 'warning', VERIFIED_AUTO: 'success', VERIFIED_MANUAL: 'success', REJECTED: 'danger', EXPIRED: 'danger', ACTIVE: 'success' };

/** The customer's signed agreements and identity documents, each opened (and logged) from the Documents page. */
export function DocumentsPanel({ customerId }: { customerId: string }) {
  const docs = useApi<{ items: any[] }>(`/documents?customerId=${customerId}&limit=50`);
  const items = (docs.data?.items ?? []).filter((x) => x.kind !== 'SIGNATURE');
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-title3 font-semibold">Documents</h2><Link className="text-subhead text-accent" href={`/documents?customerId=${customerId}`}>Open in Documents</Link></div>
      {docs.loading && !docs.data && <Spinner />}
      {docs.error && <p className="text-subhead text-label2">{docs.error}</p>}
      {docs.data && items.length === 0 && <Empty>No documents yet.</Empty>}
      <ul className="divide-y divide-separator">
        {items.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2 py-2 text-subhead">
            <Link className="font-medium text-accent" href={`/documents?customerId=${customerId}&q=${encodeURIComponent(x.name)}`}>{x.kind === 'CONTRACT' ? x.name : label(x.category)}</Link>
            <Badge tone={TONE[x.status] ?? 'neutral'}>{label(x.status)}</Badge>
            <span className="ml-auto text-footnote text-label2">{dt(x.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
