// Minimal async mutex used for the Gemini nonce and other serialized sections.

export class Mutex {
  private chain: Promise<unknown> = Promise.resolve()

  // Serialize an async operation: callers queue up in order.
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }
}
