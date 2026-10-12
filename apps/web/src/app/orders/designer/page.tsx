import type { Metadata } from 'next';
import { LargeTitle } from '@nexus/ui';
import { Designer } from './designer';

export const metadata: Metadata = { title: 'Order Rules' };

export default function Page() {
  return (
    <>
      <LargeTitle subtitle="Drag steps onto the canvas, connect them, and publish to Temporal">Order Workflow Designer</LargeTitle>
      <Designer />
    </>
  );
}
