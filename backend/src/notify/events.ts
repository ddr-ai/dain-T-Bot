// Tiny typed event bus linking the engine to the API layer (websocket push).

export type EventName = 'price' | 'activity' | 'trade' | 'status' | 'settings'

type Handler = (payload: unknown) => void

export class EventBus {
  private map = new Map<string, Set<Handler>>()

  on(name: EventName, cb: Handler): () => void {
    let set = this.map.get(name)
    if (!set) {
      set = new Set()
      this.map.set(name, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }

  emit(name: EventName, payload: unknown): void {
    const set = this.map.get(name)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch {
        // a broken subscriber must never break the engine
      }
    }
  }
}
