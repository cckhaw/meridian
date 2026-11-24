import { Suspense } from 'react';
import { ReleaseDetail } from './detail';

export const metadata = { title: 'Catalog release' };

export default function Page() {
  return <Suspense><ReleaseDetail /></Suspense>;
}
