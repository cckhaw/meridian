'use client';
import { use } from 'react';
import { CustomerView } from './customer-view';

export default function Customer360({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <CustomerView id={id} />;
}
