import { Suspense } from 'react';
import { ReleaseList } from './list';

export const metadata = { title: 'Catalog releases' };

export default function Page() {
  return <Suspense><ReleaseList /></Suspense>;
}
