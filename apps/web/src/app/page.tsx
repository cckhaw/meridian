import { Badge, Card, LargeTitle } from '@meridian/ui';
import Link from 'next/link';

const modules = [
  { href: '/catalog', title: 'Product Catalog', body: 'Network → Category → Group → Offer, with ETC-aware contracts.', status: 'Scaffolded' },
  { href: '/orders/designer', title: 'Order Rules', body: 'Drag-and-drop Temporal workflow designer with point-of-no-return.', status: 'Scaffolded' },
  { href: '/customers', title: 'Customer 360', body: 'Hierarchy, billing, cases and MNP in one view.', status: 'Planned' },
  { href: '/billing/cycles', title: 'Billing & Ledger', body: 'Multi-cycle billing, invoice designer, SAP GL export.', status: 'Planned' },
  { href: '/inventory', title: 'Inventory & Reverse Logistics', body: 'Exchanges, returns and order corrections.', status: 'Planned' },
  { href: '/retail', title: 'Retail & Omnichannel', body: 'Assisted retail, self-serve and quick-sale mode.', status: 'Planned' },
];

export default function Home() {
  return (
    <>
      <LargeTitle subtitle="Telecom CRM & Billing for 20M+ subscribers across ASEAN">Welcome to Meridian</LargeTitle>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {modules.map((m) => (
          <Link key={m.href} href={m.href} className="rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <Card className="h-full transition hover:-translate-y-0.5">
              <div className="mb-2 flex items-start justify-between gap-2">
                <h2 className="text-title3 font-semibold">{m.title}</h2>
                <Badge tone={m.status === 'Planned' ? 'neutral' : 'success'}>{m.status}</Badge>
              </div>
              <p className="text-subhead text-label2">{m.body}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
