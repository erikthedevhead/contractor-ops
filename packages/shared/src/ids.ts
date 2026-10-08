import { createHash } from 'node:crypto';

/** RFC 4122 v5 (name-based, SHA-1) UUID. Deterministic: same input, same id. */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error('namespace must be a UUID');
  const b = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Namespace for QuickBooks requestids minted by this app. */
export const QBO_REQUEST_NS = '6f1c2a4e-8b3d-5e7f-9a1b-2c3d4e5f6a7b';
