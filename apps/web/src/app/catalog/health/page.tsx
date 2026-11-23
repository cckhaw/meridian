import { Suspense } from 'react';
import { CatalogHealth } from './health';

export const metadata = { title: 'Catalogue health' };

export default function Page() {
  return <Suspense><CatalogHealth /></Suspense>;
}
