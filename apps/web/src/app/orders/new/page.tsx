import { Suspense } from 'react';
import { NewOrder } from './new-order';

export default function Page() {
  return <Suspense><NewOrder /></Suspense>;
}
