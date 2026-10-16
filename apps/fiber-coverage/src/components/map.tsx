'use client';
import { Alert, Button, Field, Input, Modal, Select } from '@meridian/ui';
import 'leaflet/dist/leaflet.css';
import type * as L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { api, post, useApi } from '@/lib/api';
import { parseTiers } from '@/lib/format';
import { Result } from './check';

/**
 * The coverage map: distribution points coloured by free ports, the reach of each, cabinets and coverage areas, with three tools.
 *  - Inspect (default): click a point for its ports, or an area for its details.
 *  - Check:  click anywhere to ask the coverage engine what a customer there would be told.
 *  - Draw:   click to place the corners of a coverage area, then name it and give it to a provider.
 * Tiles come from OpenStreetMap; change TILES (and the img-src in next.config.mjs) to use another provider.
 */
const TILES = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' };
type Tool = 'inspect' | 'check' | 'draw';
const COLOURS = ['#0a84ff', '#bf5af2', '#ff9f0a', '#30b0c7', '#ff375f', '#64d2ff', '#a2845e'];

export function MapView() {
  const providers = useApi<{ items: any[] }>('/admin/providers');
  const [provider, setProvider] = useState('');
  const [tool, setTool] = useState<Tool>('inspect');
  const [corners, setCorners] = useState<Array<[number, number]>>([]);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<null | { name: string; providerId: string; tiers: string; capacity: string }>(null);
  const [version, setVersion] = useState(0);
  const el = useRef<HTMLDivElement>(null);
  const state = useRef<{ map?: L.Map; layer?: L.LayerGroup; draft?: L.LayerGroup; lib?: typeof L; fitted?: boolean }>({});
  const toolRef = useRef<Tool>('inspect'); toolRef.current = tool;

  // build the map once
  useEffect(() => {
    let dead = false;
    (async () => {
      const lib = (await import('leaflet')).default ?? (await import('leaflet'));
      if (dead || !el.current || state.current.map) return;
      const map = lib.map(el.current, { center: [1.3521, 103.8198], zoom: 12, zoomControl: true });
      lib.tileLayer(TILES.url, { attribution: TILES.attribution, maxZoom: 19 }).addTo(map);
      state.current = { map, lib, layer: lib.layerGroup().addTo(map), draft: lib.layerGroup().addTo(map) };
      map.on('click', async (e: L.LeafletMouseEvent) => {
        const t = toolRef.current;
        if (t === 'draw') setCorners((c) => [...c, [e.latlng.lng, e.latlng.lat]]);
        if (t === 'check') {
          setBusy(true); setError(null);
          try { setResult(await post('/admin/check', { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) })); } catch (err) { setError((err as Error).message); setResult(null); } finally { setBusy(false); }
        }
      });
      setVersion((v) => v + 1);
    })();
    return () => { dead = true; state.current.map?.remove(); state.current = {}; };
  }, []);

  // draw the network
  useEffect(() => {
    const { map, layer, lib } = state.current;
    if (!map || !layer || !lib) return;
    let dead = false;
    api<any>(`/admin/map${provider ? `?providerId=${provider}` : ''}`).then((fc) => {
      if (dead) return;
      layer.clearLayers();
      const colour = new Map<string, string>(); const colourOf = (p: string) => { if (!colour.has(p)) colour.set(p, COLOURS[colour.size % COLOURS.length]!); return colour.get(p)!; };
      const bounds = lib.latLngBounds([]);
      const order: Record<string, number> = { area: 0, reach: 1, cabinet: 2, dp: 3 };
      for (const f of [...fc.features].sort((a: any, b: any) => order[a.properties.layer]! - order[b.properties.layer]!)) {
        const p = f.properties;
        if (p.layer === 'area') {
          const g = lib.geoJSON(f, { style: { color: colourOf(p.provider), weight: 2, fillOpacity: p.capacityStatus === 'EXHAUSTED' ? 0.05 : 0.15, dashArray: p.capacityStatus === 'EXHAUSTED' ? '6 4' : undefined } }).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.provider)} · ${esc(p.kind)}<br>${p.speedTiersMbps ? p.speedTiersMbps.join(', ') + ' Mbps' : 'Provider speeds'}<br>${p.capacityStatus === 'EXHAUSTED' ? 'No capacity' : 'Capacity available'}`).addTo(layer);
          bounds.extend(g.getBounds());
        } else if (p.layer === 'reach') {
          lib.geoJSON(f, { style: { color: colourOf(p.provider), weight: 1, fillOpacity: 0.06, interactive: false } as L.PathOptions, interactive: false }).addTo(layer);
        } else if (p.layer === 'cabinet') {
          const [lng, lat] = f.geometry.coordinates;
          lib.rectangle([[lat - 0.00012, lng - 0.00012], [lat + 0.00012, lng + 0.00012]], { color: '#1c1c1e', weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindPopup(`<b>Cabinet ${esc(p.code)}</b><br>${esc(p.name)}<br>${esc(p.provider)}`).addTo(layer);
          bounds.extend([lat, lng]);
        } else {
          const [lng, lat] = f.geometry.coordinates;
          const free = p.available, level = free === 0 ? '#ff3b30' : free <= 2 || free / Math.max(1, p.total - p.faulty) <= 0.15 ? '#ff9f0a' : '#34c759';
          lib.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 2, fillColor: level, fillOpacity: 1 })
            .bindPopup(`<b>${esc(p.code)}</b> · ${esc(p.name)}<br>${esc(p.provider)} · 1:${p.splitter}<br><b>${free}</b> free of ${p.total} · ${p.reserved} reserved · ${p.inUse} in use · ${p.faulty} faulty`).addTo(layer);
          bounds.extend([lat, lng]);
        }
      }
      if (!state.current.fitted && bounds.isValid()) { map.fitBounds(bounds.pad(0.2), { maxZoom: 16 }); state.current.fitted = true; }
    }).catch((e) => setError((e as Error).message));
    return () => { dead = true; };
  }, [provider, version]);

  // the area being drawn
  useEffect(() => {
    const { draft, lib } = state.current;
    if (!draft || !lib) return;
    draft.clearLayers();
    const pts = corners.map(([lng, lat]) => [lat, lng] as [number, number]);
    if (pts.length > 1) lib.polygon(pts, { color: '#ff375f', weight: 2, dashArray: '4 4', fillOpacity: 0.1 }).addTo(draft);
    pts.forEach((p) => lib.circleMarker(p, { radius: 4, color: '#ff375f', fillColor: '#fff', fillOpacity: 1 }).addTo(draft));
  }, [corners, version]);
  useEffect(() => { if (state.current.map) state.current.map.getContainer().style.cursor = tool === 'inspect' ? '' : 'crosshair'; }, [tool, version]);

  const finish = () => { setSave({ name: '', providerId: provider || providers.data?.items[0]?.id || '', tiers: '', capacity: 'AVAILABLE' }); };
  const submit = async () => {
    if (!save) return;
    setBusy(true); setError(null);
    try {
      await post('/admin/polygons', { providerId: save.providerId, name: save.name.trim(), geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]!]] }, speedTiersMbps: parseTiers(save.tiers).length ? parseTiers(save.tiers) : null, capacityStatus: save.capacity });
      setSave(null); setCorners([]); setTool('inspect'); setVersion((v) => v + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Provider"><Select value={provider} onChange={(e) => { setProvider(e.target.value); if (state.current) state.current.fitted = false; }}><option value="">All providers</option>{(providers.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <div role="radiogroup" aria-label="Tool" className="inline-flex rounded-control bg-surface2 p-0.5">
          {([['inspect', 'Inspect'], ['check', 'Check a spot'], ['draw', 'Draw an area']] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={tool === v} onClick={() => { setTool(v); setResult(null); setError(null); if (v !== 'draw') setCorners([]); }} className={`min-h-tap rounded-[8px] px-3 text-subhead font-medium ${tool === v ? 'bg-surface shadow-sm' : 'text-label2'}`}>{l}</button>))}
        </div>
        {tool === 'draw' && <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={!corners.length} onClick={() => setCorners((c) => c.slice(0, -1))}>Undo corner</Button><Button disabled={corners.length < 3} onClick={finish}>Finish area ({corners.length})</Button></div>}
      </div>
      <p className="text-footnote text-label2">
        {tool === 'inspect' && 'Green, amber and red dots are distribution points by free ports; circles show each one’s reach; outlined areas are coverage polygons (dashed: no capacity); squares are cabinets.'}
        {tool === 'check' && 'Click anywhere on the map to see what a customer at that spot would be told.'}
        {tool === 'draw' && 'Click to place the corners of the area (at least three), then Finish area.'}
      </p>
      {error && <Alert>{error}</Alert>}
      <div ref={el} className="h-[min(65dvh,640px)] min-h-[320px] w-full overflow-hidden rounded-card border border-separator bg-surface2" role="application" aria-label="Coverage map" />
      {busy && tool === 'check' && <p className="text-subhead text-label2">Checking…</p>}
      {result && tool === 'check' && <Result r={result} />}
      {save && (
        <Modal title="New coverage area" onClose={() => setSave(null)}>
          <div className="grid gap-3">
            {error && <Alert>{error}</Alert>}
            <Field label="Name"><Input value={save.name} onChange={(e) => setSave({ ...save, name: e.target.value })} /></Field>
            <Field label="Provider"><Select value={save.providerId} onChange={(e) => setSave({ ...save, providerId: e.target.value })}>{(providers.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Speed tiers (Mbps)" hint="Blank uses the provider’s tiers."><Input value={save.tiers} onChange={(e) => setSave({ ...save, tiers: e.target.value })} placeholder="100, 500, 1000" /></Field>
            <Field label="Capacity"><Select value={save.capacity} onChange={(e) => setSave({ ...save, capacity: e.target.value })}><option value="AVAILABLE">Capacity available</option><option value="EXHAUSTED">No capacity (waitlist)</option></Select></Field>
            <div className="flex gap-2"><Button disabled={busy || !save.name.trim() || !save.providerId} onClick={() => void submit()}>Save area</Button><Button variant="secondary" onClick={() => setSave(null)}>Back</Button></div>
          </div>
        </Modal>)}
    </div>
  );
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
