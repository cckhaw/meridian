'use client';
import { LargeTitle } from '@meridian/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { OfferForm } from '../../offer-form';

export default function EditOffer() {
  const { id } = useParams<{ id: string }>();
  return (
    <>
      <LargeTitle subtitle="Change pricing, fulfilment, sales channels and the products this one depends on.">Edit offer</LargeTitle>
      <p className="mb-4"><Link href="/catalog" className="text-subhead text-accent">← Back to catalog</Link></p>
      <OfferForm offerId={id} />
    </>
  );
}
