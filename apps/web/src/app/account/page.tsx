'use client';
import { Alert, Spinner } from '@meridian/ui';
import { Suspense } from 'react';
import { useAuth } from '@/lib/auth';
import { CustomerView } from '../customers/[id]/customer-view';

/** The customer portal home: the signed-in customer's own account. The API refuses any other customer id for this role. */
export default function Account() {
  const { me } = useAuth();
  if (!me) return <Spinner />;
  if (!me.customerId) return <Alert tone="info">This login is not linked to a customer account.</Alert>;
  return <Suspense><CustomerView id={me.customerId} /></Suspense>;
}
