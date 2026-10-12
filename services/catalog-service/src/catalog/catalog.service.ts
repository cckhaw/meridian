import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CatalogNode, EtcQuote, OfferNode } from '@meridian/types';
import type { Model } from 'mongoose';
import { quoteEtc } from '@meridian/core/etc';
import { CatalogNodeDoc } from './catalog.schema.js';
import { validateOffer, validateParent } from '@meridian/core/hierarchy';

@Injectable()
export class CatalogService {
  constructor(@InjectModel(CatalogNodeDoc.name) private readonly nodes: Model<CatalogNodeDoc>) {}

  async create(input: Omit<CatalogNode, 'id' | 'createdAt' | 'updatedAt' | 'version'>): Promise<unknown> {
    const parent = input.parentId ? await this.nodes.findById(input.parentId).lean() : null;
    if (input.parentId && !parent) throw new NotFoundException(`parent ${input.parentId} not found`);
    const parentErr = validateParent(input, parent);
    if (parentErr) throw new BadRequestException(parentErr);
    if (input.level === 'OFFER') {
      const errs = validateOffer(input as unknown as OfferNode);
      if (errs.length) throw new BadRequestException({ message: 'invalid offer', errors: errs });
    }
    return this.nodes.create(input);
  }

  /** Subtree under a path, e.g. "mobile/postpaid". */
  subtree(path: string, status = 'ACTIVE') {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.nodes.find({ path: new RegExp(`^${escaped}(/|$)`), status }).sort({ path: 1 }).lean();
  }

  async get(id: string) {
    const node = await this.nodes.findById(id).lean();
    if (!node) throw new NotFoundException();
    return node;
  }

  async activate(id: string) {
    const node = await this.nodes.findByIdAndUpdate(id, { status: 'ACTIVE' }, { new: true }).lean();
    if (!node) throw new NotFoundException();
    return node;
  }

  async etcQuote(offerId: string, contractStart: Date, terminationDate: Date): Promise<EtcQuote> {
    const offer = (await this.get(offerId)) as unknown as OfferNode;
    if (!offer.contract) throw new BadRequestException('offer has no contract');
    const monthly = offer.prices.find((p) => p.type === 'RECURRING')?.amount;
    return quoteEtc({ offerId, contract: offer.contract, contractStart, terminationDate, monthlyRecurring: monthly });
  }
}
