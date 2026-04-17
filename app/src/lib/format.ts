export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  // Show one decimal for <10, integer otherwise — matches what most system
  // tools display (e.g. `du -sh`).
  const formatted = value < 10 ? value.toFixed(1) : Math.round(value).toString()
  return `${formatted} ${units[i]}`
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const diffMs = then - Date.now()
  const absSec = Math.abs(diffMs) / 1000

  const table: Array<[number, Intl.RelativeTimeFormatUnit, number]> = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [604800, 'day', 86400],
    [2629800, 'week', 604800],
    [31557600, 'month', 2629800],
    [Number.POSITIVE_INFINITY, 'year', 31557600],
  ]
  for (const [threshold, unit, divisor] of table) {
    if (absSec < threshold) {
      const value = Math.round(diffMs / 1000 / divisor)
      return RTF.format(value, unit)
    }
  }
  return '—'
}
