
/** A catalog node as the browse/detail APIs return it. Offer and line-item fields are optional on the other levels. */
export interface CNode {
  id: string; name: string; level: 'NETWORK_TYPE' | 'CATEGORY' | 'GROUP' | 'OFFER' | 'LINE_ITEM'; status: string; path: string; parentId?: string | null;
  networkType?: string; kind?: string; description?: string; prices?: any[]; contract?: any; fulfilment?: any; requires?: string[]; excludes?: string[]; salesChannels?: string[]; markets?: string[];
  itemType?: string; quantity?: number; unit?: string; unlimited?: boolean; sku?: string; sortOrder?: number;
  offerCount: number; activeOfferCount: number; lineItemCount: number; trail?: Array<{ id: string; name: string; level: string }>;
  [k: string]: any;
}
export type TreeNode = CNode;

export const LEVEL_NOUN: Record<string, string> = { NETWORK_TYPE: 'network type', CATEGORY: 'category', GROUP: 'group', OFFER: 'offer', LINE_ITEM: 'line item' };
export const LEVEL_PLURAL: Record<string, string> = { NETWORK_TYPE: 'Network types', CATEGORY: 'Categories', GROUP: 'Groups', OFFER: 'Offers', LINE_ITEM: 'Line items' };
export const CHILD_LEVEL: Record<string, CNode['level'] | undefined> = { NETWORK_TYPE: 'CATEGORY', CATEGORY: 'GROUP', GROUP: 'OFFER', OFFER: 'LINE_ITEM' };

export const ITEM_TYPES: Array<{ value: string; label: string; glyph: string; unit?: string }> = [
  { value: 'DATA', label: 'Data allowance', glyph: '◔', unit: 'GB' },
  { value: 'VOICE', label: 'Voice calls', glyph: '☏', unit: 'min' },
  { value: 'SMS', label: 'SMS', glyph: '✉', unit: 'SMS' },
  { value: 'SIM', label: 'SIM card', glyph: '▤', unit: 'SIM' },
  { value: 'DEVICE', label: 'Device', glyph: '▯', unit: 'unit' },
  { value: 'ACCESSORY', label: 'Accessory', glyph: '◇', unit: 'unit' },
  { value: 'SERVICE', label: 'Service', glyph: '✦' },
  { value: 'CONTENT', label: 'Content / subscription', glyph: '▶' },
  { value: 'OTHER', label: 'Other', glyph: '•' },
];
export const itemMeta = (t?: string) => ITEM_TYPES.find((i) => i.value === t) ?? ITEM_TYPES[ITEM_TYPES.length - 1]!;
/** "100 GB", "Unlimited", "2 units", or nothing for descriptive items. */
export const itemAmount = (i: Pick<TreeNode, 'quantity' | 'unit' | 'unlimited'>) =>
  i.unlimited ? 'Unlimited' : !i.quantity ? '' : ['unit', 'SIM'].includes(i.unit ?? '') ? (i.quantity > 1 ? `${i.quantity} ×` : '') : `${i.quantity.toLocaleString()}${i.unit ? ` ${i.unit}` : ''}`;

export const STATUS_DOT: Record<string, string> = { ACTIVE: 'bg-success', DRAFT: 'bg-warning', RETIRED: 'bg-label2/50' };
export const STATUS_TEXT: Record<string, string> = { ACTIVE: 'Live', DRAFT: 'Draft', RETIRED: 'Retired' };
