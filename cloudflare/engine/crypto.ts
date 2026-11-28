// AES-256-GCM encryption for anything sensitive at rest (the Gemini
// key/secret). Same wire format as netlify/engine/crypto.ts
// ({ v, iv, tag, data } base64), so a blob encrypted by the Netlify engine
// decrypts here and vice versa. Differences from the Netlify version:
//   * WebCrypto (crypto.subtle) instead of node:crypto, because ciphers in
//     node:crypto are not reliably available in the Workers runtime
//   * the master key comes from the injected bindings (getEnv()) instead of
//     process.env.CREDS_MASTER_KEY
// WebCrypto's AES-GCM encrypt returns ciphertext||tag; the last 16 bytes are
// the auth tag, split out to keep the { data, tag } document identical.

import { getEnv } from './config.ts'

function masterKeyRaw(): string {
  const raw = getEnv().CREDS_MASTER_KEY ?? ''
  if (raw.length < 16) {
    throw new Error('Cannot store credentials: the credentials master key secret is not configured on the Worker')
  }
  return raw
}

async function aesKey(): Promise<CryptoKey> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(masterKeyRaw()))
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export interface EncryptedDoc {
  v: 1
  iv: string
  tag: string
  data: string
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function encryptForBlob(plaintext: string): Promise<EncryptedDoc> {
  const key = await aesKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  const tag = sealed.subarray(sealed.length - 16)
  const data = sealed.subarray(0, sealed.length - 16)
  return { v: 1, iv: b64(iv), tag: b64(tag), data: b64(data) }
}

export async function decryptFromBlob(doc: EncryptedDoc): Promise<string> {
  const key = await aesKey()
  const data = unb64(doc.data)
  const tag = unb64(doc.tag)
  const sealed = new Uint8Array(data.length + tag.length)
  sealed.set(data)
  sealed.set(tag, data.length)
  const iv = unb64(doc.iv)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed)
  return new TextDecoder().decode(plain)
}
