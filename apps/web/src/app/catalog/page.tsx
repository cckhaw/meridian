import { Suspense } from 'react';
import { CatalogBrowser } from './browser';

export const metadata = { title: 'Catalog' };

export default function Page() {
  return <Suspense><CatalogBrowser /></Suspense>;
}
