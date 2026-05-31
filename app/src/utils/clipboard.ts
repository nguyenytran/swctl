/**
 * Copy text to the clipboard, with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost).
 * The swctl UI is typically served over plain HTTP (e.g. http://swctl.orb.local
 * via OrbStack), where `navigator.clipboard` is `undefined` — so we fall back to
 * the legacy `execCommand('copy')` on a hidden textarea. We also fall back if
 * the async API rejects (e.g. permission denied or transient failure).
 *
 * Returns true on success, false if both paths fail.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Preferred: async Clipboard API (secure contexts only).
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* fall through to the execCommand fallback */
    }
  }
  // Fallback: hidden textarea + execCommand('copy'). Works over plain HTTP.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
