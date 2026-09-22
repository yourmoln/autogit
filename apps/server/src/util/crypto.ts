import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { customAlphabet } from 'nanoid';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = 'v1';

const idAlphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

export function randomId(prefix: string): string {
  return `${prefix}_${idAlphabet()}`;
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const base64 = Buffer.from(trimmed, 'base64');
  if (base64.length >= KEY_BYTES) return base64.subarray(0, KEY_BYTES);
  // Derive a stable 32 byte key from an arbitrary passphrase.
  return Buffer.from(trimmed.padEnd(KEY_BYTES, 'autogit-secret').slice(0, KEY_BYTES), 'utf8');
}

export function loadOrCreateSecretKey(keyPath: string, envValue?: string): Buffer {
  const configured = envValue?.trim();
  if (configured) return decodeKey(configured);

  if (existsSync(keyPath)) {
    return decodeKey(readFileSync(keyPath, 'utf8'));
  }

  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows does not support POSIX modes; ignoring is fine.
  }
  return key;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Unsupported secret payload format');
  }
  const iv = Buffer.from(parts[1] as string, 'base64url');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  const data = Buffer.from(parts[3] as string, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function maskSecret(plain: string): string {
  if (!plain) return '';
  if (plain.length <= 8) return `${plain.slice(0, 2)}…`;
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}
