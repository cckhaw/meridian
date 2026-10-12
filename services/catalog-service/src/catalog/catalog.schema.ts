import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { CatalogNodeLevel, OfferKind } from '@meridian/types';
import type { HydratedDocument } from 'mongoose';

/** Single-collection polymorphic hierarchy keyed by materialised path (prefix queries via ^path/). */
@Schema({ collection: 'catalog_nodes', timestamps: true, versionKey: 'version' })
export class CatalogNodeDoc {
  @Prop({ required: true, enum: ['NETWORK_TYPE', 'CATEGORY', 'GROUP', 'OFFER', 'LINE_ITEM'], index: true }) level!: CatalogNodeLevel;
  @Prop({ required: true }) code!: string;
  @Prop({ required: true }) name!: string;
  @Prop({ required: true, unique: true, index: true }) path!: string;
  @Prop({ type: String, default: null, index: true }) parentId!: string | null;
  @Prop({ required: true, enum: ['DRAFT', 'ACTIVE', 'RETIRED'], default: 'DRAFT', index: true }) status!: string;
  @Prop({ type: [String], default: [], index: true }) markets!: string[];
  @Prop({ enum: ['mobile', 'fiber', 'iot', 'none'] }) networkType?: string;
  @Prop({ type: String }) kind?: OfferKind;
  @Prop() description?: string;
  @Prop({ type: [Object], default: [] }) prices!: unknown[];
  @Prop({ type: Object }) contract?: unknown;
  @Prop({ type: Object }) fulfilment?: unknown;
  @Prop() partnerCode?: string;
  @Prop({ type: Object, default: {} }) characteristics!: Record<string, unknown>;
  @Prop({ type: [String], default: [] }) requires!: string[];
  @Prop({ type: [String], default: [] }) excludes!: string[];
}

export type CatalogNodeDocument = HydratedDocument<CatalogNodeDoc>;
export const CatalogNodeSchema = SchemaFactory.createForClass(CatalogNodeDoc);
CatalogNodeSchema.index({ level: 1, kind: 1, status: 1 });
CatalogNodeSchema.index({ name: 'text', code: 'text' });
