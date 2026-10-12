export type ErrorCode = 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'REJECTED';

/** Business-rule failure. `status` is the HTTP status the API layer should use. */
export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'DomainError';
  }
  get status() {
    return { NOT_FOUND: 404, INVALID: 400, CONFLICT: 409, REJECTED: 422 }[this.code];
  }
}
export const notFound = (what: string, id?: string) => new DomainError('NOT_FOUND', `${what}${id ? ` ${id}` : ''} not found`);
export const invalid = (msg: string, details?: unknown) => new DomainError('INVALID', msg, details);
export const conflict = (msg: string) => new DomainError('CONFLICT', msg);
export const rejected = (msg: string) => new DomainError('REJECTED', msg);
