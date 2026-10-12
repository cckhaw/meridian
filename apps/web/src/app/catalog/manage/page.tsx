import { Suspense } from 'react';
import { ManageCatalog } from './manage';

export const metadata = { title: 'Manage catalog' };

export default function Page() {
  return <Suspense><ManageCatalog /></Suspense>;
}
