import crypto from 'node:crypto';
import type { FoundationBundle, FoundationSignature } from './contracts.js';

export type FoundationImportErrorCode =
  | 'FOUNDATION_INVALID_PERSONA'
  | 'FOUNDATION_INVALID_BUNDLE'
  | 'FOUNDATION_ACCOUNT_MISMATCH'
  | 'FOUNDATION_ACCOUNT_BLOCKED'
  | 'FOUNDATION_SIGNATURE_REQUIRED'
  | 'FOUNDATION_INVALID_SIGNATURE'
  | 'FOUNDATION_REPLAY'
  | 'FOUNDATION_INVALID_RECORD';

export class FoundationImportError extends Error {
  readonly code: FoundationImportErrorCode;

  constructor(code: FoundationImportErrorCode, message: string) {
    super(message);
    this.name = 'FoundationImportError';
    this.code = code;
  }
}

export interface SignFoundationBundleInput {
  alg: 'hmac-sha256' | 'ed25519';
  secret?: string | Buffer;
  privateKey?: string | Buffer | crypto.KeyObject;
  keyId?: string;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== undefined) {
      sorted[key] = canonicalizeValue(val);
    }
  }
  return sorted;
}

export function serializeFoundationSigningPayload(bundle: FoundationBundle): string {
  const unsignedPayload: Record<string, unknown> = {
    version: bundle.version,
    bundle_id: bundle.bundle_id,
    default_persona_id: bundle.default_persona_id,
    subject_id: bundle.subject_id,
    target_own_id: bundle.target_own_id,
    source_snapshot: bundle.source_snapshot,
    issued_at: bundle.issued_at,
    watermark: bundle.watermark,
    revocations: bundle.revocations,
    records: bundle.records,
  };
  return JSON.stringify(canonicalizeValue(unsignedPayload));
}

export function computeFoundationPayloadHash(bundle: FoundationBundle): string {
  return crypto
    .createHash('sha256')
    .update(serializeFoundationSigningPayload(bundle), 'utf8')
    .digest('hex');
}

export function signFoundationBundle(
  bundle: FoundationBundle,
  options: SignFoundationBundleInput,
): FoundationBundle {
  const payload = Buffer.from(serializeFoundationSigningPayload(bundle), 'utf8');
  let value: string;
  if (options.alg === 'hmac-sha256') {
    if (!options.secret) {
      throw new FoundationImportError(
        'FOUNDATION_INVALID_SIGNATURE',
        'HMAC secret is required to sign foundation bundle',
      );
    }
    value = crypto.createHmac('sha256', options.secret).update(payload).digest('hex');
  } else if (options.alg === 'ed25519') {
    if (!options.privateKey) {
      throw new FoundationImportError(
        'FOUNDATION_INVALID_SIGNATURE',
        'Ed25519 private key is required to sign foundation bundle',
      );
    }
    value = crypto.sign(null, payload, options.privateKey).toString('base64');
  } else {
    throw new FoundationImportError(
      'FOUNDATION_INVALID_SIGNATURE',
      `Unsupported foundation signature algorithm: ${String(options.alg)}`,
    );
  }

  const signature: FoundationSignature = {
    alg: options.alg,
    value,
    ...(options.keyId ? { keyId: options.keyId } : {}),
  };
  return {
    ...bundle,
    signature,
  };
}

export function verifyFoundationSignature(
  bundle: FoundationBundle,
  keys: {
    hmacSecret?: string | Buffer;
    ed25519PublicKey?: string | Buffer | crypto.KeyObject;
  },
): boolean {
  const sig = bundle.signature;
  if (!sig || typeof sig.value !== 'string' || !sig.value.trim()) {
    return false;
  }
  const payload = Buffer.from(serializeFoundationSigningPayload(bundle), 'utf8');
  if (sig.alg === 'hmac-sha256') {
    if (!keys.hmacSecret) return false;
    const expected = crypto.createHmac('sha256', keys.hmacSecret).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(sig.value.trim(), 'hex');
    } catch {
      return false;
    }
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }
  if (sig.alg === 'ed25519') {
    if (!keys.ed25519PublicKey) return false;
    let sigBytes: Buffer;
    try {
      sigBytes = Buffer.from(sig.value.trim(), 'base64');
    } catch {
      return false;
    }
    if (sigBytes.length === 0) return false;
    try {
      return crypto.verify(null, payload, keys.ed25519PublicKey, sigBytes);
    } catch {
      return false;
    }
  }
  return false;
}
