// AES-256-GCM credential vault. The API key/secret are stored encrypted
// at rest in backend/data/credentials.enc and are NEVER logged.
// The key comes from ENCRYPTION_KEY (hashed to 32 bytes).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GeminiCreds } from '../gemini/types.ts'

export class CredentialsStore {
  constructor(private filePath: string, private key: Buffer | undefined) {}

  private ensureKey(): Buffer {
    if (!this.key || this.key.length !== 32) {
      throw new Error('Cannot persist credentials: ENCRYPTION_KEY is not configured (32-byte base64 string in .env)')
    }
    return this.key
  }

  save(creds: GeminiCreds): void {
    const key = this.ensureKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plain = Buffer.from(JSON.stringify(creds), 'utf8')
    const ct = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    const doc = { v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: ct.toString('base64') }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 })
    renameSync(tmp, this.filePath)
  }

  load(): GeminiCreds | undefined {
    if (!existsSync(this.filePath)) return undefined
    try {
      const key = this.key
      if (!key || key.length !== 32) return undefined
      const doc = JSON.parse(readFileSync(this.filePath, 'utf8')) as { iv: string, tag: string, data: string }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(doc.tag, 'base64'))
      const pt = Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()])
      const creds = JSON.parse(pt.toString('utf8')) as GeminiCreds
      if (typeof creds.key === 'string' && typeof creds.secret === 'string' && creds.key.length > 0) return creds
      return undefined
    } catch {
      // wrong key or corrupted file: treat as empty, never crash the bot
      return undefined
    }
  }

  clear(): void {
    if (existsSync(this.filePath)) {
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, 'nothing')
      renameSync(tmp, this.filePath)
    }
  }
}
