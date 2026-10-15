import { createHash } from 'node:crypto';
import type { Queryable } from '../db.js';
import { offersTemplate } from '../offer-import.js';
import { csvCell } from '../csv.js';
import { ENTITIES, entityById, importFields } from './entities.js';
import type { EntityDef, FieldDef } from './types.js';

/**
 * Templates: for every record type, a file with the exact header, what each column takes (type, required, the pattern or values it must match, what it means)
 * and example rows. A template has a version that changes when a column does; the registry table keeps the published version so a job can say which it used.
 */
export const templateVersion = (def: EntityDef): string => createHash('sha1').update(JSON.stringify(importFields(def).map((f) => [f.name, f.type, !!f.required, f.pattern ?? '', f.values ?? []]))).digest('hex').slice(0, 8);

const TYPE_TEXT: Record<FieldDef['type'], string> = {
  text: 'text', int: 'whole number', money: 'whole number of minor units (cents)', date: 'date YYYY-MM-DD', timestamp: 'date and time, ISO 8601', bool: 'true or false', enum: 'one of the listed values',
  json: 'JSON document', ref: 'the key of a record in another file', list: 'items separated by |',
};
const rule = (f: FieldDef) => [f.values ? `one of ${f.values.join(', ')}` : '', f.pattern ? `matches /${f.pattern}/` : '', f.max ? `up to ${f.max} characters` : '', f.ref ? `points at ${f.ref}` : ''].filter(Boolean).join('; ');

/** The cells of the second example: only what is required, to show the smallest valid row. */
const minimal = (fields: FieldDef[]) => fields.map((f) => (f.required ? f.example : ''));

export async function templateCsv(q: Queryable, def: EntityDef): Promise<string> {
  if (def.id === 'offers') return offersTemplate(q, { withOffers: false });
  const fields = importFields(def).filter((f) => !f.jsonOnly);
  const lines = [
    `# Meridian import template: ${def.label} (${def.id}) · version ${templateVersion(def)} · load phase ${def.phase}`,
    `# ${def.description}`,
    ...(def.note ? [`# ${def.note}`] : []),
    ...(def.dependsOn.length ? [`# Load first: ${def.dependsOn.map((d) => entityById(d)?.label ?? d).join(', ')}.`] : []),
    '# Lines that start with # are ignored. Keep the header row below as it is. One record per row. Dates are YYYY-MM-DD, times ISO 8601 (2026-01-31T09:30:00Z), money is whole minor units.',
    '# Columns (* = required):',
    ...fields.map((f) => `#   ${f.name}${f.required ? ' *' : ''} — ${TYPE_TEXT[f.type]}${rule(f) ? `; ${rule(f)}` : ''}. ${f.hint}.`),
    `# Example 1: ${fields.map((f) => csvCell(f.example)).join(',')}`,
    `# Example 2 (only what is required): ${minimal(fields).map(csvCell).join(',')}`,
    fields.map((f) => f.name).join(','),
  ];
  return lines.join('\r\n') + '\r\n';
}

export function templateJson(def: EntityDef): string {
  const fields = importFields(def);
  const doc = (blank: boolean) => Object.fromEntries(fields.map((f) => {
    if (blank && !f.required) return [f.name, null];
    const e = f.example;
    return [f.name, f.type === 'json' ? (e ? safeJson(e) : null) : f.type === 'int' || f.type === 'money' ? (e === '' ? null : Number(e)) : f.type === 'bool' ? e === 'true' : f.type === 'list' ? (e ? e.split('|') : []) : e];
  }));
  return JSON.stringify({
    template: {
      entity: def.id, label: def.label, version: templateVersion(def), phase: def.phase, domain: def.domain, description: def.description, note: def.note ?? null, loadFirst: def.dependsOn,
      format: 'Put your records in "records", as an array of objects with these fields. A file that is only an array of records, or one record per line (NDJSON), also loads.',
      fields: fields.map((f) => ({ name: f.name, type: f.type, required: !!f.required, pattern: f.pattern ?? null, values: f.values ?? null, maxLength: f.max ?? null, pointsAt: f.ref ?? null, meaning: f.hint, example: f.example })),
    },
    examples: [doc(false), doc(true)],
    records: [],
  }, null, 2) + '\n';
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

export interface TemplateInfo { id: string; label: string; domain: string; phase: number; description: string; importable: boolean; dependsOn: string[]; version: string; columns: number; required: string[]; note: string | null }
export function templateInfo(def: EntityDef): TemplateInfo {
  return { id: def.id, label: def.label, domain: def.domain, phase: def.phase, description: def.description, importable: def.importable, dependsOn: def.dependsOn, version: templateVersion(def), columns: importFields(def).length, required: importFields(def).filter((f) => f.required).map((f) => f.name), note: def.note ?? null };
}

/** Publishes the templates to the registry table when a column has changed (or one is new), and returns what is published. */
export async function publishTemplates(q: Queryable): Promise<TemplateInfo[]> {
  for (const def of ENTITIES) {
    await q.query(
      `INSERT INTO data_templates (entity, version, label, domain, phase, importable, columns) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (entity) DO UPDATE SET version=EXCLUDED.version, label=EXCLUDED.label, domain=EXCLUDED.domain, phase=EXCLUDED.phase, importable=EXCLUDED.importable, columns=EXCLUDED.columns,
         updated_at = CASE WHEN data_templates.version = EXCLUDED.version THEN data_templates.updated_at ELSE now() END`,
      [def.id, templateVersion(def), def.label, def.domain, def.phase, def.importable, JSON.stringify(importFields(def).map((f) => ({ name: f.name, type: f.type, required: !!f.required, pattern: f.pattern ?? null, values: f.values ?? null, hint: f.hint, example: f.example })))]);
  }
  return ENTITIES.map(templateInfo);
}
