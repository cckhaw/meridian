import type { Queryable } from '../db.js';

/**
 * The description of one kind of record that can be exported and imported. Everything the engine does (templates, exports, checks, loads) is driven by
 * these descriptions, so adding a record type is writing one definition, not another feature.
 */
export const DOMAINS = [
  { id: 'product', label: 'Product', description: 'Catalog structure, offers, offer types and the types that cannot be ordered together, fulfilment options, service types, VIP number tiers, bundle rules, terms and cancellation rules' },
  { id: 'customer', label: 'Customer', description: 'Customer segments, customers (with enterprise departments and IoT hierarchies), accounts, service groups and their members' },
  { id: 'operations', label: 'Operations', description: 'Stores, dealers, agents, commission plans and earnings, warehouses, stock and transfers' },
  { id: 'subscriber', label: 'Subscriber and financial', description: 'Services, the SIM, IMSI and number inventory, number porting, scheduled plan changes, ledger balances and active dunning cases' },
  { id: 'sales', label: 'Orders and sales', description: 'Orders with their lines and fulfilment groups, payments, sign-up applications and credit checks' },
  { id: 'billing', label: 'Billing, dunning and finance', description: 'Bill cycles, templates and runs, invoices, dunning rules, late fees, early-termination rules, posting rules, arrangements and collections' },
  { id: 'care', label: 'Cases and field service', description: 'Case taxonomy and SLAs, cases and their history, customer interactions, field-service and installation appointments' },
  { id: 'documents', label: 'Documents and KYC', description: 'Agreement templates and versions, the document vault records, signatures, the access log and identity verifications' },
  { id: 'fiber', label: 'Fibre coverage', description: 'Providers, cabinets, distribution points, ports, coverage areas, the waiting list and expansion requests' },
  { id: 'platform', label: 'Security, integration and platform', description: 'Staff users, fraud blacklist, API clients and keys, webhooks, integration endpoints, rate limits, event topics, all settings and the audit log' },
] as const;
export type DomainId = (typeof DOMAINS)[number]['id'];

/** The order records must be loaded in, so that whatever a record points at is already there. */
export const PHASES = [
  { phase: 1, label: 'Catalog, configuration and inventory pools' },
  { phase: 2, label: 'Stores, dealers, agents, warehouses, stock and users' },
  { phase: 3, label: 'Customers and accounts' },
  { phase: 4, label: 'Services, subscriptions and group mappings' },
  { phase: 5, label: 'Balances, dunning cases and transaction history' },
] as const;

export type FieldType = 'text' | 'int' | 'money' | 'date' | 'timestamp' | 'bool' | 'enum' | 'json' | 'ref' | 'list';
/** How a sensitive field is treated in an export unless the super user asks, with a reason, for it unmasked. */
export type Sensitivity = 'MASK' | 'PSEUDONYM';
export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  /** Plain-words hint, shown in templates. */
  hint: string;
  example: string;
  /** A regular expression (source) the value must match. */
  pattern?: string;
  values?: string[];
  /** For a `ref`: the entity the value points at. */
  ref?: string;
  max?: number;
  sensitive?: Sensitivity;
  /** Only in JSON files (a nested document), not in CSV. */
  jsonOnly?: boolean;
  /** Only read on import (never exported): a plain ID number that becomes a masked reference and a hash, say. */
  importOnly?: boolean;
}

export type Rec = Record<string, unknown>;
export interface ReadPage { rows: Rec[]; next: string | null }

export interface EntityDef {
  id: string;
  label: string;
  domain: DomainId;
  phase: 1 | 2 | 3 | 4 | 5;
  description: string;
  fields: FieldDef[];
  /** Entities that must be loaded first. */
  dependsOn: string[];
  /** False: it can be exported but not loaded from a file (yet). */
  importable: boolean;
  /** A note that goes with the template: how keys work, what is not supported. */
  note?: string;
  /** The table, for estimating how many rows there are. */
  table: string;
  /** One keyset-ordered page of rows after `after` (null: from the start). Keys of each row are the field names. */
  read(q: Queryable, after: string | null, limit: number): Promise<ReadPage>;
  /** For a child record type: its rows for a page of parents (`field` is the column that points at the parent), so JSON can nest them. */
  byParent?: (q: Queryable, field: string, keys: string[]) => Promise<Rec[]>;
  /** JSON files only: child records nested under their parent (customer → accounts), so the document reads as a hierarchy. */
  nest?: Array<{ as: string; entity: string; parentField: string; childField: string }>;
}
