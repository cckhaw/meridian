export const FLAG_TEXT: Record<string, string> = {
  DUPLICATE_IDENTITY: 'ID already registered to a customer',
  IDENTITY_USED_ELSEWHERE: 'ID used in another approved application',
  IMAGE_REUSED: 'A photo was already used in another case',
  NOT_LIVE_CAPTURE: 'Some photos were not taken with the live camera',
};
export const DOC_LABEL: Record<string, string> = { ID_FRONT: 'ID (front)', ID_BACK: 'ID (back)', SELFIE: 'Selfie', PROOF_OF_ADDRESS: 'Proof of address', SIGNATURE: 'Customer signature', COMPANY_REGISTRATION: 'Company registration certificate' };
export const SOURCE_LABEL: Record<string, string> = { STOREFRONT: 'Online shop', ASSISTED: 'Store counter', CRM_ORDER: 'CRM order', CRM_CUSTOMER: 'CRM customer' };
export const REASONS: Array<[string, string]> = [['NOT_AN_ID', 'Not an ID document'], ['UNREADABLE', 'Unreadable or cut off'], ['MISMATCH', 'Photo or details do not match'], ['EXPIRED', 'ID expired'], ['SUSPECTED_FRAUD', 'Suspected fraud'], ['OTHER', 'Other']];
export const ID_TYPE_LABEL: Record<string, string> = { NATIONAL_ID: 'National ID', PASSPORT: 'Passport', DRIVING_LICENCE: 'Driving licence', RESIDENCE_PERMIT: 'Residence permit' };
