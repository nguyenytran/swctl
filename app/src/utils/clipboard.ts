/**
 * Copy text to clipboard with fallback for non-HTTPS contexts (e.g. HTTP via OrbStack).
 * navigator.clipboard requires a secure context (HTTPS or localhost).
 */
export function copyToClipboard(text: string): boolean {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text)
    return true
  }
  // Fallback: create a temporary textarea and use execCommand
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
