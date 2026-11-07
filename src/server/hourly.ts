// Runs a job once an hour at a fixed minute (UTC), one run at a time. It
// replaces the Worker's cron trigger, "7 * * * *".

/** The first time after `after` whose minute is `minute`, at second 0. */
export function nextRun(after: Date, minute: number): Date {
  const next = new Date(after)
  next.setUTCMinutes(minute, 0, 0)
  if (next <= after) next.setUTCHours(next.getUTCHours() + 1)
  return next
}

/**
 * Starts the schedule. An hour whose start finds the last run still going is
 * skipped. `stop` ends the schedule and waits for a running job.
 */
export function startHourly(data: { minute: number; run: (time: Date) => Promise<void>; now?: () => Date }) {
  const now = data.now ?? (() => new Date())
  let job: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (after: Date) => {
    const at = nextRun(after, data.minute)
    timer = setTimeout(() => {
      // From `at`, not from now: a timer that fires early must not plan the same run again.
      schedule(at)
      if (job) return console.error('Hourly job skipped: the last run is still going')
      job = data
        .run(at)
        .catch((error: unknown) => console.error('Hourly job failed', error))
        .finally(() => {
          job = null
        })
    }, Math.max(0, at.getTime() - now().getTime()))
  }
  schedule(now())
  return {
    stop: async () => {
      clearTimeout(timer)
      await job
    },
  }
}
