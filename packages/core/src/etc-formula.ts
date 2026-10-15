/**
 * The small formula language behind Settings → Early termination. It is arithmetic over named values, never code: numbers, the names below, + - * / %, comparisons,
 * && || !, `cond ? a : b`, parentheses, and min, max, round, floor, ceil, abs, clamp(x, lo, hi), pct(x, percent). A formula is checked when it is saved (unknown
 * names, bad syntax) and again for division by zero when it runs; nothing in it can reach the rest of the system.
 */
export const ETC_VARIABLES: Array<{ name: string; label: string; money: boolean; example: number }> = [
  { name: 'term', label: 'Contract length in months', money: false, example: 24 },
  { name: 'elapsed', label: 'Whole months already served', money: false, example: 8 },
  { name: 'remaining', label: 'Months left on the contract', money: false, example: 16 },
  { name: 'monthlyFee', label: 'Monthly fee of the plan (smallest currency unit)', money: true, example: 6800 },
  { name: 'subsidy', label: 'Device subsidy given (smallest currency unit)', money: true, example: 40000 },
  { name: 'retailPrice', label: 'Retail price of the device', money: true, example: 120000 },
  { name: 'deviceBalance', label: 'Device instalments not yet billed', money: true, example: 53000 },
  { name: 'deviceInstalment', label: 'Monthly device instalment', money: true, example: 3300 },
  { name: 'newMonthlyFee', label: 'Monthly fee of the plan being moved to (plan change only, else 0)', money: true, example: 0 },
  { name: 'vipMultiplier', label: 'VIP number multiplier (1 = none, 1.5 = 150%)', money: false, example: 1 },
];
const NAMES = new Set(ETC_VARIABLES.map((v) => v.name));
const FUNCS: Record<string, { n: number | [number, number]; f: (...a: number[]) => number }> = {
  min: { n: [2, 8], f: Math.min }, max: { n: [2, 8], f: Math.max }, round: { n: 1, f: Math.round }, floor: { n: 1, f: Math.floor }, ceil: { n: 1, f: Math.ceil }, abs: { n: 1, f: Math.abs },
  clamp: { n: 3, f: (x, lo, hi) => Math.min(Math.max(x, lo), hi) }, pct: { n: 2, f: (x, p) => (x * p) / 100 },
};

type Node =
  | { t: 'num'; v: number } | { t: 'var'; name: string } | { t: 'un'; op: '-' | '!'; a: Node } | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] } | { t: 'cond'; c: Node; a: Node; b: Node };

class Parser {
  private i = 0;
  private tokens: string[];
  constructor(src: string) {
    if (src.length > 500) throw new Error('The formula is too long (500 characters at most).');
    this.tokens = src.match(/\s*(\d+\.?\d*|\.\d+|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||==|!=|<=|>=|[-+*/%()<>!?:,]|\S)/g)?.map((t) => t.trim()) ?? [];
    for (const t of this.tokens) if (!/^(\d+\.?\d*|\.\d+|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||==|!=|<=|>=|[-+*/%()<>!?:,])$/.test(t)) throw new Error(`“${t}” is not allowed in a formula.`);
  }
  private peek = () => this.tokens[this.i];
  private next = () => this.tokens[this.i++];
  private eat(t: string) { if (this.peek() !== t) throw new Error(`Expected “${t}”${this.peek() ? ` but found “${this.peek()}”` : ' at the end'}.`); this.i++; }
  parse(): Node {
    if (!this.tokens.length) throw new Error('The formula is empty.');
    const n = this.cond();
    if (this.i < this.tokens.length) throw new Error(`Unexpected “${this.peek()}”.`);
    return n;
  }
  private depth = 0;
  private guard<T>(f: () => T): T { if (++this.depth > 40) throw new Error('The formula is nested too deeply.'); try { return f(); } finally { this.depth--; } }
  private cond(): Node { return this.guard(() => { const c = this.or(); if (this.peek() === '?') { this.next(); const a = this.cond(); this.eat(':'); const b = this.cond(); return { t: 'cond', c, a, b } as Node; } return c; }); }
  private or(): Node { let a = this.and(); while (this.peek() === '||') { this.next(); a = { t: 'bin', op: '||', a, b: this.and() }; } return a; }
  private and(): Node { let a = this.cmp(); while (this.peek() === '&&') { this.next(); a = { t: 'bin', op: '&&', a, b: this.cmp() }; } return a; }
  private cmp(): Node { let a = this.add(); while (['==', '!=', '<', '<=', '>', '>='].includes(this.peek() ?? '')) { const op = this.next()!; a = { t: 'bin', op, a, b: this.add() }; } return a; }
  private add(): Node { let a = this.mul(); while (this.peek() === '+' || this.peek() === '-') { const op = this.next()!; a = { t: 'bin', op, a, b: this.mul() }; } return a; }
  private mul(): Node { let a = this.unary(); while (['*', '/', '%'].includes(this.peek() ?? '')) { const op = this.next()!; a = { t: 'bin', op, a, b: this.unary() }; } return a; }
  private unary(): Node { if (this.peek() === '-' || this.peek() === '!') { const op = this.next() as '-' | '!'; return { t: 'un', op, a: this.unary() }; } return this.primary(); }
  private primary(): Node {
    const t = this.next();
    if (t === undefined) throw new Error('The formula ends too soon.');
    if (/^(\d|\.)/.test(t)) return { t: 'num', v: Number(t) };
    if (t === '(') { const n = this.cond(); this.eat(')'); return n; }
    if (/^[A-Za-z_]/.test(t)) {
      if (this.peek() === '(') {
        const f = FUNCS[t];
        if (!f) throw new Error(`Unknown function “${t}”. Use ${Object.keys(FUNCS).join(', ')}.`);
        this.next(); const args: Node[] = [];
        if (this.peek() !== ')') { args.push(this.cond()); while (this.peek() === ',') { this.next(); args.push(this.cond()); } }
        this.eat(')');
        const [lo, hi] = Array.isArray(f.n) ? f.n : [f.n, f.n];
        if (args.length < lo || args.length > hi) throw new Error(`${t}() takes ${lo === hi ? lo : `${lo} to ${hi}`} values.`);
        return { t: 'call', name: t, args };
      }
      if (!NAMES.has(t)) throw new Error(`Unknown name “${t}”. Use ${ETC_VARIABLES.map((v) => v.name).join(', ')}.`);
      return { t: 'var', name: t };
    }
    throw new Error(`Unexpected “${t}”.`);
  }
}

export interface CompiledFormula { source: string; ast: Node }
/** Throws an Error whose message is meant to be shown to the person writing the formula. */
export function compileFormula(src: string): CompiledFormula {
  return { source: src, ast: new Parser(src).parse() };
}
export function evaluateFormula(f: CompiledFormula | string, vars: Record<string, number>): number {
  const ast = typeof f === 'string' ? compileFormula(f).ast : f.ast;
  const ev = (n: Node): number => {
    switch (n.t) {
      case 'num': return n.v;
      case 'var': return vars[n.name] ?? 0;
      case 'un': { const a = ev(n.a); return n.op === '-' ? -a : a ? 0 : 1; }
      case 'cond': return ev(n.c) ? ev(n.a) : ev(n.b);
      case 'call': return FUNCS[n.name]!.f(...n.args.map(ev));
      case 'bin': {
        if (n.op === '&&') return ev(n.a) && ev(n.b) ? 1 : 0;
        if (n.op === '||') return ev(n.a) || ev(n.b) ? 1 : 0;
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': if (b === 0) throw new Error('The formula divides by zero for these figures.'); return a / b;
          case '%': if (b === 0) throw new Error('The formula divides by zero for these figures.'); return a % b;
          case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0; case '<': return a < b ? 1 : 0; case '<=': return a <= b ? 1 : 0; case '>': return a > b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
        }
      }
    }
    return 0;
  };
  const r = ev(ast);
  if (!Number.isFinite(r)) throw new Error('The formula did not give a number.');
  return r;
}
