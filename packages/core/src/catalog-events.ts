import type { Queryable, Row } from './db.js';
import { raiseEvent, type DomainEventType } from './events.js';

/**
 * TMF620 notifications. Every change to the catalogue (the Catalog screen, the bulk offers import, the TMF620 API) raises a business event in the outbox in the
 * same transaction as the change, so TM Forum 688 listeners and webhooks hear about it through the normal event hub:
 *
 *   ProductOffering / Category  CreateEvent, StateChangeEvent (lifecycle: draft, scheduled, active, retired), AttributeValueChangeEvent, DeleteEvent
 *
 * A change to one of an offer's line items is a change of its specification, so it is announced as an AttributeValueChangeEvent of the offering
 * (`changedAttributes` has `productSpecification`). Like the high-volume events, these are only written while somebody listens for them.
 */

/** TMF lifecycleStatus of a catalogue status. Draft and Scheduled are both "In design" (a scheduled one has a future validFor.startDateTime). */
export const LIFECYCLE: Record<string, string> = { DRAFT: 'In design', SCHEDULED: 'In design', ACTIVE: 'Active', RETIRED: 'Retired' };

const TMF620_PATH = 'productCatalogManagement/v4';
const CATEGORY_LEVELS = ['NETWORK_TYPE', 'CATEGORY', 'GROUP'];

/** What an attribute of the catalogue is called in TMF620; anything TMF620 has no place for is under the `@meridian` extension. */
const ATTRIBUTE: Record<string, string> = {
  name: 'name', description: 'description', prices: 'productOfferingPrice', contract: 'productOfferingTerm', requires: 'productOfferingRelationship', excludes: 'productOfferingRelationship',
  salesChannels: 'channel', markets: 'place', itemType: 'productSpecification', quantity: 'productSpecification', unit: 'productSpecification', unlimited: 'productSpecification', sku: 'productSpecification',
};
export const tmfAttribute = (key: string): string => ATTRIBUTE[key] ?? `@meridian.${key}`;
/** The TMF attributes behind a list of changed catalogue fields, without repeats. */
export const tmfAttributes = (keys: string[]): string[] => [...new Set(keys.map(tmfAttribute))];

export interface CatalogEventNode { id: string; level: string; name: string; status: string; parentId?: string | null; version?: number | null; updatedAt?: unknown; activeFrom?: string | Date | null }
type Kind = 'created' | 'changed' | 'state' | 'deleted';

const TYPES: Record<'offering' | 'category', Record<Kind, DomainEventType>> = {
  offering: { created: 'OFFERING_CREATED', changed: 'OFFERING_CHANGED', state: 'OFFERING_STATE_CHANGED', deleted: 'OFFERING_DELETED' },
  category: { created: 'CATEGORY_CREATED', changed: 'CATEGORY_CHANGED', state: 'CATEGORY_STATE_CHANGED', deleted: 'CATEGORY_DELETED' },
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

/**
 * Announces a change to a catalogue node. `changed` lists the TMF attribute names that changed (for an attribute-value change); `previousStatus` is the status
 * before a state change. A line item is announced as its offering: the event is about the offering whose specification changed.
 */
export async function raiseCatalogEvent(q: Queryable, kind: Kind, node: CatalogEventNode, o: { changed?: string[]; previousStatus?: string } = {}): Promise<void> {
  let subject: CatalogEventNode | undefined = node;
  let changed = o.changed;
  let event: Kind = kind;
  if (node.level === 'LINE_ITEM') {
    // the offering is what changed, not the item: a line item is part of its specification
    const row: Row | undefined = node.parentId ? (await q.query('SELECT id, level, name, status, parent_id, version, updated_at, active_from FROM catalog_nodes WHERE id=$1', [node.parentId])).rows[0] : undefined;
    if (!row) return;     // an offer deleted together with its items: the offer's own delete event is the news
    subject = row as unknown as CatalogEventNode;
    event = 'changed';
    changed = ['productSpecification'];
  }
  const family = CATEGORY_LEVELS.includes(subject.level) ? 'category' : 'offering';
  const resource = family === 'category' ? 'category' : 'productOffering';
  const type = TYPES[family][event];
  await raiseEvent(q, type, {
    resourceId: subject.id,
    payload: {
      name: subject.name, version: String(subject.version ?? 1), lifecycleStatus: LIFECYCLE[subject.status], lastUpdate: iso(subject.updatedAt) ?? new Date().toISOString(),
      ...(subject.status === 'SCHEDULED' && subject.activeFrom ? { validFor: { startDateTime: iso(subject.activeFrom) } } : {}),
      ...(event === 'state' && o.previousStatus ? { previousLifecycleStatus: LIFECYCLE[o.previousStatus] } : {}),
      ...(event === 'changed' && changed?.length ? { changedAttributes: changed } : {}),
      ...(subject.parentId ? (family === 'category' ? { parentId: subject.parentId } : { category: { id: subject.parentId } }) : {}),
      href: `/api/tmf-api/${TMF620_PATH}/${resource}/${subject.id}`,
    },
  }, { onlyIfWanted: true });
}
