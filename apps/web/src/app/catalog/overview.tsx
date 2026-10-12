'use client';
import { Button, Empty, LargeTitle } from '@meridian/ui';
import { LEVEL_PLURAL, STATUS_DOT } from './catalog-ui';
import type { TreeNode } from './node-modals';

/** What you see before choosing anything: the shape of the catalog and a way in. */
export function Overview({ roots, all, editable, onSelect, onNewRoot }: { roots: TreeNode[]; all: TreeNode[]; editable: boolean; onSelect: (id: string) => void; onNewRoot: () => void }) {
  const count = (l: TreeNode['level']) => all.filter((n) => n.level === l).length;
  const offers = all.filter((n) => n.level === 'OFFER');
  const live = offers.filter((o) => o.status === 'ACTIVE').length;
  const stats: Array<[string, number, string?]> = [
    [LEVEL_PLURAL.NETWORK_TYPE!, count('NETWORK_TYPE')], [LEVEL_PLURAL.CATEGORY!, count('CATEGORY')], [LEVEL_PLURAL.GROUP!, count('GROUP')],
    ['Offers live', live, `of ${offers.length}`], [LEVEL_PLURAL.LINE_ITEM!, count('LINE_ITEM')],
  ];
  return (
    <div>
      <div className="hidden lg:block"><LargeTitle subtitle="Network type → Category → Group → Offer → Line items. Pick something on the left to see and edit it.">Product catalog</LargeTitle></div>
      <ul className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {stats.map(([k, v, sub]) => (
          <li key={k} className="rounded-card bg-surface p-4 shadow-card"><p className="text-footnote text-label2">{k}</p><p className="text-title2 font-semibold tabular-nums">{v}{sub && <span className="ml-1 text-subhead font-normal text-label2">{sub}</span>}</p></li>
        ))}
      </ul>
      <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">Network types</h2>
      {roots.length === 0 ? <Empty>The catalog is empty. {editable ? 'Start with a network type (Mobile, Fibre, IoT…), then add categories, groups and offers beneath it.' : 'No products are available yet.'}</Empty> : (
        <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {roots.map((n) => (
            <li key={n.id}><button onClick={() => onSelect(n.id)} className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none">
              <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[n.status]}`} /><span className="flex-1"><span className="block font-medium">{n.name}</span><span className="text-footnote text-label2">{n.activeOfferCount} of {n.offerCount} offers live</span></span><span aria-hidden className="text-label2">›</span>
            </button></li>
          ))}
        </ul>
      )}
      {editable && <div className="mt-4"><Button variant="secondary" onClick={onNewRoot}>＋ New network type</Button></div>}
    </div>
  );
}
