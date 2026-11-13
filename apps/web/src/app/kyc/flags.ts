export const FLAG_TEXT: Record<string, string> = {
  DUPLICATE_IDENTITY: 'ID already registered to a customer',
  IDENTITY_USED_ELSEWHERE: 'ID used in another approved application',
  IMAGE_REUSED: 'A photo was already used in another case',
  NOT_LIVE_CAPTURE: 'Some photos were not taken with the live camera',
  PROVIDER_REVIEW: 'The ID check service is not sure: see its verdict',
  PROVIDER_FAIL: 'The ID check service did not accept the documents (automatic rejection is off)',
  PROVIDER_UNAVAILABLE: 'The ID check service could not be reached, so a person checks the documents',
};
export const DOC_LABEL: Record<string, string> = { ID_FRONT: 'ID (front)', ID_BACK: 'ID (back)', SELFIE: 'Selfie', PROOF_OF_ADDRESS: 'Proof of address', SIGNATURE: 'Customer signature', COMPANY_REGISTRATION: 'Company registration certificate' };
export const SOURCE_LABEL: Record<string, string> = { STOREFRONT: 'Online shop', ASSISTED: 'Store counter', CRM_ORDER: 'CRM order', CRM_CUSTOMER: 'CRM customer' };
export const REASONS: Array<[string, string]> = [['NOT_AN_ID', 'Not an ID document'], ['UNREADABLE', 'Unreadable or cut off'], ['MISMATCH', 'Photo or details do not match'], ['EXPIRED', 'ID expired'], ['SUSPECTED_FRAUD', 'Suspected fraud'], ['OTHER', 'Other']];
export const ID_TYPE_LABEL: Record<string, string> = { NATIONAL_ID: 'National ID', PASSPORT: 'Passport', DRIVING_LICENCE: 'Driving licence', RESIDENCE_PERMIT: 'Residence permit' };
export const METHOD_LABEL: Record<string, string> = { DOCUMENT_REMOTE: 'Photographed online', DOCUMENT_STORE: 'Photographed in the CRM', IN_PERSON: 'ID sighted in store', MYDIGITAL_ID: 'MyDigital ID' };
export const RISK_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { LOW: 'neutral', MEDIUM: 'warning', HIGH: 'danger' };
export const ASSIGN_HOW: Record<string, string> = { AUTO: 'Shared out automatically', MANUAL: 'Assigned by a manager', CLAIMED: 'Claimed by the officer', ESCALATED: 'Passed up by escalation', RESUBMIT: 'Returned to the same officer after a resubmission', NEXT: 'Taken with Get next case' };
/** What the officer ticks before deciding. The keys are what the API stores with the decision. */
export const CHECKLIST: Array<{ key: string; label: string; hint: string }> = [
  { key: 'documentLegible', label: 'Document is legible', hint: 'Every field can be read and nothing is cut off or covered.' },
  { key: 'photoMatchesId', label: 'Photo matches the ID', hint: 'The selfie and the portrait on the ID are the same person.' },
  { key: 'detailsMatchId', label: 'Details match the ID', hint: 'Name, number and date of birth equal what was entered.' },
  { key: 'notExpired', label: 'ID is not expired', hint: 'The expiry date is in the future.' },
  { key: 'ageOk', label: 'Age requirement is met', hint: 'The applicant is old enough to contract.' },
  { key: 'notDuplicate', label: 'Not a duplicate', hint: 'No other customer or open application uses this ID.' },
];
export const EVENT_LABEL: Record<string, string> = { ASSIGNED: 'Assigned', REASSIGNED: 'Reassigned', UNASSIGNED: 'Returned to the pool', CLAIMED: 'Claimed', RELEASED: 'Released', OPENED: 'Opened', NOTE: 'Note added', ESCALATED: 'Escalated', APPROVED: 'Approved', REJECTED: 'Rejected', RETURNED: 'Sent back', DECIDED: 'Decided', REOPENED: 'Reopened', SECOND_REVIEW: 'Second review', QA: 'Quality check', SUBMITTED: 'Submitted' };
