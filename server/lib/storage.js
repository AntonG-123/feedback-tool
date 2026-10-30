// File storage for screenshots, image attachments and audio. Binary data never
// goes into the database; rows keep a storage_key that points here. The local
// disk driver is used with a persistent volume. An S3-compatible driver can be
// added behind the same three functions.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { randomToken } from './crypto.js';

function resolveKey(key) {
  if (!/^[a-z0-9/_\-.]+$/i.test(key) || key.includes('..')) throw new Error('invalid storage key');
  return path.join(config.storageDir, key);
}

export function newKey(prefix, ext) {
  const d = new Date();
  return `${prefix}/${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomToken(16)}${ext}`;
}

export async function put(key, buffer) {
  const p = resolveKey(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buffer);
  return key;
}

export async function remove(key) {
  await fs.rm(resolveKey(key), { force: true });
}

export async function stat(key) {
  try {
    return await fs.stat(resolveKey(key));
  } catch {
    return null;
  }
}

export function stream(key) {
  return createReadStream(resolveKey(key));
}
