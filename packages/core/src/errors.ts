export type ErrorCode = 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'REJECTED' | 'FORBIDDEN' | 'UNAUTHENTICATED' | 'RATE_LIMITED';

/** Business-rule failure. `status` is the HTTP status the API layer should use. */
export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'DomainError';
  }
  get status() {
    return { NOT_FOUND: 404, INVALID: 400, CONFLICT: 409, REJECTED: 422, FORBIDDEN: 403, UNAUTHENTICATED: 401, RATE_LIMITED: 429 }[this.code];
  }
}
export const notFound = (what: string, id?: string) => new DomainError('NOT_FOUND', `${what}${id ? ` ${id}` : ''} not found`);
export const invalid = (msg: string, details?: unknown) => new DomainError('INVALID', msg, details);
export const conflict = (msg: string) => new DomainError('CONFLICT', msg);
export const rejected = (msg: string) => new DomainError('REJECTED', msg);
export const forbidden = (msg = 'You do not have access to this.') => new DomainError('FORBIDDEN', msg);
export const unauthenticated = (msg = 'Sign in to continue.') => new DomainError('UNAUTHENTICATED', msg);
