// Scheduled engine heartbeat: runs the full engine tick (manage positions,
// then scan for entries if the run window is active) once every minute
// regardless of whether anyone has the app open. Errors are swallowed so a
// transient Gemini/Blobs hiccup never kills the schedule.

import { engineTick } from '../engine/tick.ts'

export const config = { schedule: '* * * * *' }

export default async (): Promise<void> => {
  try {
    await engineTick()
  } catch {
    // next scheduled run retries; failures also land in the activity feed
  }
}
