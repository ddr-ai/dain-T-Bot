// AES-256-GCM encryption for anything sensitive at rest in Blobs (the
// Gemini key/secret). The master key comes from the CREDS_MASTER_KEY site
// environment variable and is hashed to a 32-byte AES key, exactly like
// ENCRYPTION_KEY in the standalone backend.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

function masterKey(): Buffer {
  const raw = process.env.CREDS_MASTER_KEY ?? ''
  if (raw.length < 16) {
    throw new Error('Cannot store credentials: CREDS_MASTER_KEY is not configured on the site (set it in Netlify env vars)')
  }
  return createHash('sha256').update(raw).digest()
}

export interface EncryptedDoc {
  v: 1
  iv: string
  tag: string
  data: string
}

export async function encryptForBlob(plaintext: string): Promise<EncryptedDoc> {
  const key = masterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') }
}

export async function decryptFromBlob(doc: EncryptedDoc): Promise<string> {
  const key = masterKey()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(doc.tag, 'base64'))
  const pt = Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()])
  return pt.toString('utf8')
}
