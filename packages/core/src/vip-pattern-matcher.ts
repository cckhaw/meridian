/**
 * Puts a phone number in a tier by looking at the end of it: the digits people remember. Rules are data (`msisdn_vip_tier_rules`): each tier has a
 * list of regular expressions matched against the last 8 digits of the number (after the country code, so +6012-8888888 is judged on 28888888).
 * Tiers are tried in order (Auction/special first, then Diamond, Gold, Silver); a number matching nothing is Standard.
 *
 *   Diamond   AAAAA (88888, 666666...), runs such as 123456 or 654321
 *   Gold      AABBCC (334455), ABABAB (121212), AAAA (7777)
 *   Silver    AABB (1122), ABAB (1212), ABABCC (121288), four in a row (1234)
 *   Auction   all eight digits the same, or whatever the operator adds
 */
export type VipTier = 'DIAMOND' | 'GOLD' | 'SILVER' | 'STANDARD' | 'AUCTION';
export const VIP_TIERS: readonly VipTier[] = ['AUCTION', 'DIAMOND', 'GOLD', 'SILVER', 'STANDARD'];
export const TAIL_DIGITS = 8;
const MAX_REGEX = 160;

export interface TierPattern { code: string; regex: string }
export interface TierRule {
  tier: VipTier; label: string; sortOrder: number; patterns: TierPattern[];
  oneTimeFeeMinor: number; minMonthlyPlanMinor: number; minContractMonths: number; etcMultiplierBps: number; enabled: boolean;
}
export interface Classification { tier: VipTier; patternCode: string | null }

/** A rule's regular expression, checked before it is saved: it must compile, be short, and not nest quantifiers (which could stall the matcher). */
export function patternProblem(p: TierPattern): string | null {
  if (!p.code?.trim() || p.code.length > 30) return 'Give every pattern a short name.';
  if (typeof p.regex !== 'string' || !p.regex || p.regex.length > MAX_REGEX) return `The pattern “${p.code}” must be 1 to ${MAX_REGEX} characters.`;
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(p.regex.replace(/\\\d/g, ''))) return `The pattern “${p.code}” repeats a repeat, which is not allowed.`;
  try { new RegExp(p.regex); } catch { return `The pattern “${p.code}” is not a valid regular expression.`; }
  return null;
}

export class VipPatternMatcher {
  private readonly compiled: Array<{ tier: VipTier; code: string; re: RegExp }>;

  constructor(rules: TierRule[]) {
    this.compiled = rules
      .filter((r) => r.enabled && r.tier !== 'STANDARD')
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .flatMap((r) => r.patterns.filter((p) => !patternProblem(p)).map((p) => ({ tier: r.tier, code: p.code, re: new RegExp(p.regex) })));
  }

  /** The digits that decide the tier: the last 8 of the number. */
  static tailOf(msisdn: string): string {
    const digits = msisdn.replace(/\D/g, '');
    return digits.slice(-TAIL_DIGITS);
  }

  classify(msisdn: string): Classification {
    const tail = VipPatternMatcher.tailOf(msisdn);
    for (const c of this.compiled) if (c.re.test(tail)) return { tier: c.tier, patternCode: c.code };
    return { tier: 'STANDARD', patternCode: null };
  }

  /** Classifies a whole imported range at once: the count per tier and each number's result. */
  classifyMany(msisdns: string[]): { counts: Record<VipTier, number>; results: Array<{ msisdn: string } & Classification> } {
    const counts: Record<VipTier, number> = { AUCTION: 0, DIAMOND: 0, GOLD: 0, SILVER: 0, STANDARD: 0 };
    const results = msisdns.map((msisdn) => { const c = this.classify(msisdn); counts[c.tier]++; return { msisdn, ...c }; });
    return { counts, results };
  }
}
