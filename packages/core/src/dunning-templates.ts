import type { DunningTemplateKey } from './dunning-rules.js';

/**
 * The words of the notices. `{{name}}`-style placeholders are filled when a notice is sent: name, brand, balance, dueDate, daysPastDue, payUrl, qr (what to scan),
 * lateFee, terminationDate, etc (what ending the contract early would cost), bureau (the credit bureau named in the final demand). A placeholder with nothing
 * to put in it disappears, and so does the sentence it is in when the sentence is marked `[?key: …]`.
 * Text is English: translate it in the rule (the message field) for another language. It is a starting point for the operator's own wording and legal review.
 */
export const DUNNING_TEMPLATES: Record<DunningTemplateKey, { label: string; text: string }> = {
  FRIENDLY_REMINDER: { label: 'Friendly reminder', text: 'Hi {{name}}, your {{brand}} bill of {{balance}} was due on {{dueDate}}. [?qr: Scan to pay instantly: {{qr}}. ][?payUrl: Or pay here: {{payUrl}}. ]Already paid? Thank you, please ignore this message.' },
  FIRST_NOTICE: { label: 'First notice (grace period over)', text: 'Dear {{name}}, your {{brand}} account is {{daysPastDue}} days overdue: {{balance}} is unpaid. [?lateFee: A late payment charge of {{lateFee}} applies. ][?payUrl: Pay now: {{payUrl}}. ]Please pay to avoid restrictions on your service.' },
  SECOND_NOTICE: { label: 'Second notice', text: 'Dear {{name}}, we still have not received {{balance}} for your {{brand}} account, now {{daysPastDue}} days overdue. [?payUrl: Pay now: {{payUrl}}. ]Your service will be restricted if it stays unpaid.' },
  SOFT_BAR_NOTICE: { label: 'Soft bar notice', text: 'Dear {{name}}, because {{balance}} is {{daysPastDue}} days overdue, outgoing calls, SMS and mobile data on your {{brand}} number are now blocked. You can still receive calls and SMS and use the {{brand}} app and payment page. [?payUrl: Pay now to restore service: {{payUrl}}. ]' },
  HARD_BAR_NOTICE: { label: 'Hard bar notice', text: 'Dear {{name}}, your {{brand}} service is now fully suspended because {{balance}} is {{daysPastDue}} days overdue. Emergency calls remain available. [?payUrl: Pay now and service returns within minutes: {{payUrl}}. ]' },
  FINAL_DEMAND: { label: 'Final demand before termination', text: 'FINAL NOTICE. Dear {{name}}, {{balance}} on your {{brand}} account is {{daysPastDue}} days overdue. [?terminationDate: Unless it is paid your contract will be terminated on {{terminationDate}}. ][?etc: Ending a contract early carries an early-termination charge, currently estimated at {{etc}}. ]The unpaid amount may be passed to a collection agency[?bureau: and reported to {{bureau}}]. [?payUrl: Pay now: {{payUrl}}. ]' },
  ACCOUNT_MANAGER_NOTICE: { label: 'Account manager heads-up', text: 'Dear {{name}}, your {{brand}} account has {{balance}} overdue ({{daysPastDue}} days). Your account manager will be in touch. [?payUrl: To pay now: {{payUrl}}. ]' },
};

/** Fills a template. `[?key: text]` is kept only when `key` has a value. */
export function renderDunningText(text: string, vars: Record<string, string | number | null | undefined>): string {
  const has = (k: string) => vars[k] !== undefined && vars[k] !== null && String(vars[k]) !== '';
  return text
    .replace(/\[\?(\w+):\s*([^\]]*)\]/g, (_, k: string, body: string) => (has(k) ? body : ''))
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (has(k) ? String(vars[k]) : ''))
    .replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}
