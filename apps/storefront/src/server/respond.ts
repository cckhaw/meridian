import { CoreError } from './core';

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
export const failure = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

/** Turns CRM errors into the same {error:{code,message}} shape; anything unexpected becomes a generic 500 with no details. */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); } catch (e) {
    if (e instanceof CoreError) return failure(e.status, e.code, e.message);
    console.error('[storefront]', e);
    return failure(500, 'INTERNAL', 'Something went wrong. Please try again.');
  }
}
