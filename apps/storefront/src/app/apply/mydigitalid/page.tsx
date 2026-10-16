'use client';
import { Alert, Button, Card, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/** Where MyDigital ID sends the shopper back to. It hands the code to the shop's own API and returns to the sign-up. */
export default function Page() {
  const router = useRouter();
  const [state, setState] = useState<{ status: 'working' | 'done' | 'failed'; message?: string }>({ status: 'working' });
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return; once.current = true;
    const p = new URLSearchParams(window.location.search);
    const st = p.get('state');
    if (!st) { setState({ status: 'failed', message: 'This page is opened by MyDigital ID. Go back to your sign-up and choose MyDigital ID again.' }); return; }
    api<{ status: 'DONE' | 'FAILED'; message: string }>('/mydigitalid/complete', { method: 'POST', json: { state: st, code: p.get('code') ?? undefined, error: p.get('error') ?? undefined } })
      .then((r) => { if (r.status === 'DONE') { setState({ status: 'done', message: r.message }); setTimeout(() => router.replace('/apply'), 900); } else setState({ status: 'failed', message: r.message }); })
      .catch((e: Error) => setState({ status: 'failed', message: e.message }));
  }, [router]);
  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <div className="space-y-4" role="status" aria-live="polite">
          {state.status === 'working' && <><h1 className="text-title3 font-semibold">Confirming with MyDigital ID…</h1><Spinner /></>}
          {state.status === 'done' && <><h1 className="text-title3 font-semibold">You’re verified</h1><p className="text-subhead text-label2">{state.message}</p></>}
          {state.status === 'failed' && <>
            <h1 className="text-title3 font-semibold">We couldn’t confirm with MyDigital ID</h1>
            <Alert>{state.message}</Alert>
            <Link href="/apply"><Button>Back to my sign-up</Button></Link>
          </>}
        </div>
      </Card>
    </div>
  );
}
