// Thread-safe monotonic nonce source.
// Gemini rejects nonces that are not strictly increasing per API key.
// All private requests acquire the mutex, take a nonce, then release.

import { Mutex } from '../util/lock.ts'

export class NonceManager {
  private mutex = new Mutex()
  private last = 0

  // Returns the next nonce, guaranteed strictly increasing across concurrent calls.
  next(): Promise<string> {
    return this.mutex.run(() => {
      let n = Date.now() * 1000
      if (n <= this.last) n = this.last + 1
      this.last = n
      return String(n)
    })
  }

  // Raise the floor after a clock skew / nonce rejection causes restart-like state.
  bump(ms?: number): void {
    const floor = (ms ?? Date.now()) * 1000
    if (floor > this.last) this.last = floor
  }
}
