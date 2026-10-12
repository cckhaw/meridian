'use client';
import { LargeTitle } from '@meridian/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { OfferForm } from '../offer-form';

/** New offer (`?parent=<group>`) or a new version of an existing one (`?from=<offer>`). Hierarchy levels are managed on the catalog page itself. */
export function ManageCatalog() {
  const q = useSearchParams();
  return (
    <>
      <LargeTitle subtitle="Define what customers can buy. New offers start as drafts unless you make them active.">New offer</LargeTitle>
      <p className="mb-4"><Link href="/catalog" className="text-subhead text-accent">← Back to catalog</Link></p>
      <OfferForm parentId={q.get('parent')} fromId={q.get('from')} />
    </>
  );
}
