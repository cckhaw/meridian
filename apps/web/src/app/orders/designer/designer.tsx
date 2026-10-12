'use client';
import type { OrderWorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeType } from '@nexus/types';
import { Badge, Button, Card } from '@nexus/ui';
import { useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react';

const PALETTE: Array<{ type: WorkflowNodeType; label: string }> = [
  { type: 'VALIDATE_ORDER', label: 'Validate order' }, { type: 'CREDIT_CHECK', label: 'Credit check' },
  { type: 'CAPTURE_PAYMENT', label: 'Capture payment' }, { type: 'RESERVE_INVENTORY', label: 'Reserve inventory' },
  { type: 'SCHEDULE_INSTALLATION', label: 'Schedule installation' }, { type: 'SHIP_GOODS', label: 'Ship goods' },
  { type: 'POINT_OF_NO_RETURN', label: 'Point of no return' }, { type: 'ACTIVATE_SERVICE', label: 'Activate service' },
  { type: 'NOTIFY', label: 'Notify customer' }, { type: 'CONDITION', label: 'Condition' },
];

const W = 176, H = 56;
let seq = 1;
const mk = (type: WorkflowNodeType, label: string, x: number, y: number): WorkflowNode => ({ id: `n${seq++}`, type, label, position: { x, y }, config: {} });

/** Client-side mirror of the structural checks in services/order-service/src/graph/validate.ts. */
function problems(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const out: string[] = [];
  if (nodes.filter((n) => n.type === 'START').length !== 1) out.push('Needs one Start');
  if (!nodes.some((n) => n.type === 'END')) out.push('Needs an End');
  for (const n of nodes) {
    if (n.type === 'END') continue;
    const k = edges.filter((e) => e.from === n.id).length;
    if (n.type === 'CONDITION' ? k !== 2 : k !== 1) out.push(`"${n.label}" has ${k} outgoing connection(s)`);
  }
  const pnr = nodes.find((n) => n.type === 'POINT_OF_NO_RETURN');
  const ship = nodes.find((n) => n.type === 'SHIP_GOODS');
  if (ship && !pnr) out.push('Shipping without a Point of No Return allows cancelling shipped orders');
  return out;
}

export function Designer() {
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => [mk('START', 'Start', 40, 40), mk('END', 'End', 40, 360)]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const issues = useMemo(() => problems(nodes, edges), [nodes, edges]);

  const drop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/node-type') as WorkflowNodeType;
    const def = PALETTE.find((p) => p.type === type);
    const r = canvas.current?.getBoundingClientRect();
    if (!def || !r) return;
    setNodes((ns) => [...ns, mk(type, def.label, Math.max(0, e.clientX - r.left - W / 2), Math.max(0, e.clientY - r.top - H / 2))]);
  };
  const addTap = (type: WorkflowNodeType, label: string) => setNodes((ns) => [...ns, mk(type, label, 40 + (ns.length % 3) * 200, 120 + ((ns.length / 3) | 0) * 80)]); // touch fallback: HTML5 DnD is unreliable on mobile

  const down = (e: PointerEvent, n: WorkflowNode) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { id: n.id, dx: e.clientX - n.position.x, dy: e.clientY - n.position.y }; };
  const move = (e: PointerEvent) => { const d = drag.current; if (!d) return; setNodes((ns) => ns.map((n) => (n.id === d.id ? { ...n, position: { x: Math.max(0, e.clientX - d.dx), y: Math.max(0, e.clientY - d.dy) } } : n))); };
  const connect = (id: string) => {
    if (!linkFrom) return setLinkFrom(id);
    if (linkFrom !== id) {
      const src = nodes.find((n) => n.id === linkFrom);
      const used = edges.filter((e) => e.from === linkFrom);
      const branch = src?.type === 'CONDITION' ? (used.some((e) => e.branch === 'true') ? 'false' : 'true') : undefined;
      setEdges((es) => [...es, { id: `e${seq++}`, from: linkFrom, to: id, branch }]);
    }
    setLinkFrom(null);
  };
  const remove = (id: string) => { setNodes((ns) => ns.filter((n) => n.id !== id)); setEdges((es) => es.filter((e) => e.from !== id && e.to !== id)); };

  const def: OrderWorkflowDefinition = { id: 'custom', name: 'Custom flow', version: 1, appliesTo: { channels: [], offerKinds: [] }, nodes, edges };
  const publish = async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_ORDER_API ?? 'http://localhost:4002'}/tmf-api/productOrderingManagement/v5/workflowDefinition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(def) });
    alert(res.ok ? 'Published' : `Rejected: ${(await res.json()).errors?.join('; ') ?? res.status}`);
  };
  const by = (id: string) => nodes.find((n) => n.id === id);

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <Card className="lg:self-start">
        <h2 className="mb-3 text-subhead font-semibold text-label2">Steps</h2>
        <ul className="flex flex-wrap gap-2 lg:flex-col">
          {PALETTE.map((p) => (
            <li key={p.type}>
              <button draggable onDragStart={(e) => e.dataTransfer.setData('text/node-type', p.type)} onClick={() => addTap(p.type, p.label)}
                className="min-h-tap w-full cursor-grab rounded-control bg-surface2 px-3 text-left text-subhead focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{p.label}</button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-footnote text-label2">Tap or drag to add. Select a step, then another, to connect.</p>
      </Card>

      <div className="flex flex-col gap-3">
        <div ref={canvas} onDragOver={(e) => e.preventDefault()} onDrop={drop}
          className="relative h-[480px] touch-none overflow-auto rounded-card border border-dashed border-separator bg-surface"
          style={{ backgroundImage: 'radial-gradient(rgb(var(--label-2) / .25) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="rgb(var(--label-2))" /></marker></defs>
            {edges.map((e) => { const a = by(e.from), b = by(e.to); if (!a || !b) return null;
              const x1 = a.position.x + W / 2, y1 = a.position.y + H, x2 = b.position.x + W / 2, y2 = b.position.y;
              return <g key={e.id}><path d={`M${x1} ${y1} C${x1} ${y1 + 40},${x2} ${y2 - 40},${x2} ${y2}`} fill="none" stroke="rgb(var(--label-2))" strokeWidth="1.5" markerEnd="url(#arr)" />
                {e.branch && <text x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2} fontSize="11" fill="rgb(var(--label-2))">{e.branch}</text>}</g>; })}
          </svg>
          {nodes.map((n) => (
            <div key={n.id} role="group" aria-label={n.label} onPointerDown={(e) => down(e, n)} onPointerMove={move} onPointerUp={() => (drag.current = null)}
              style={{ left: n.position.x, top: n.position.y, width: W, height: H }}
              className={`absolute flex cursor-grab select-none items-center justify-between gap-1 rounded-control px-3 text-subhead shadow-card ${n.type === 'POINT_OF_NO_RETURN' ? 'bg-warning/20' : 'bg-surface2'} ${linkFrom === n.id ? 'ring-2 ring-accent' : ''}`}>
              <span className="truncate font-medium">{n.label}</span>
              <span className="flex">
                <button aria-label={`Connect ${n.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => connect(n.id)} className="min-h-[28px] min-w-[28px] rounded-full text-accent">⤳</button>
                {n.type !== 'START' && n.type !== 'END' && <button aria-label={`Remove ${n.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(n.id)} className="min-h-[28px] min-w-[28px] rounded-full text-danger">×</button>}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" aria-live="polite">{issues.length ? issues.map((i) => <Badge key={i} tone="warning">{i}</Badge>) : <Badge tone="success">Valid</Badge>}</div>
          <Button onClick={publish} disabled={issues.length > 0}>Publish</Button>
        </div>
      </div>
    </div>
  );
}
