/**
 * Tiny in-memory response cache + Hono middleware.
 *
 * Goals (explicit non-goals: Redis, multi-process, SWR, cache stampede):
 *   - One-process, short-TTL cache for read-heavy GET endpoints.
 *   - Zero deps — uses `globalThis.setTimeout` + a plain Map.
 *   - Works with `hono/node-server`; doesn't need the Web Cache API.
 *   - Event-driven invalidation via the existing `events.subscribe` bus.
 *
 * Usage:
 *   app.get('/api/foo', cacheGet({ ttlMs: 5_000, tag: 'instances' }), handler)
 *   invalidateTag('instances')   // manual flush
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import { LRUCache } from 'lru-cache'
import { subscribe, type ServerEvent } from './events.js'

interface Entry {
  body: string
  status: number
  headers: Record<string, string>
  tag?: string
}

// Bounded LRU store with native per-entry TTL.  `max` caps memory at ~a
// few MB worst case (500 × a few KB); adjust upward only if we start
// seeing eviction-induced cache misses in healthy traffic.
const store = new LRUCache<string, Entry>({
  max: 500,
  allowStale: false,
  updateAgeOnGet: false,
})

/**
 * Purge every entry tagged with `tag`.  No-op if nothing matched.
 */
export function invalidateTag(tag: string): number {
  let n = 0
  // Collect first, then delete — mutating during `entries()` iteration is
  // well-defined in lru-cache but iterating-and-deleting in one pass is
  // easier to reason about.
  const victims: string[] = []
  for (const [k, v] of store.entries()) {
    if (v.tag === tag) victims.push(k)
  }
  for (const k of victims) { store.delete(k); n++ }
  return n
}

/**
 * Remove a single key (rarely needed — prefer `invalidateTag`).
 */
export function invalidateKey(key: string): boolean {
  return store.delete(key)
}

/**
 * Manual insert-or-replace.  Exposed for tests.
 */
export function setEntry(key: string, entry: Entry): void {
  store.set(key, entry)
}

/**
 * How many entries are currently live.  Exposed for diagnostics.
 */
export function cacheSize(): number { return store.size }

/**
 * Middleware factory.  Keys the cache by `method + path + sorted query`
 * unless the caller overrides via `keyFn`.
 *
 *   tag       : optional invalidation bucket (see `invalidateTag`).
 *   ttlMs     : entry lifetime in ms.
 *   keyFn     : custom key builder (defaults to method+path+query).
 *   headerHint: send `X-Cache: HIT | MISS` so the browser Network tab
 *               makes caching visible.  Default true.
 */
export function cacheGet(opts: {
  ttlMs: number
  tag?: string
  keyFn?: (c: Context) => string
  headerHint?: boolean
}): MiddlewareHandler {
  const { ttlMs, tag, keyFn, headerHint = true } = opts
  return async (c: Context, next: Next) => {
    if (c.req.method !== 'GET') return next()

    const key = keyFn ? keyFn(c) : defaultKey(c)
    const hit = store.get(key)
    if (hit) {
      // lru-cache already filtered expired entries on get(); no manual check.
      const h = new Headers(hit.headers)
      if (headerHint) h.set('X-Cache', 'HIT')
      return new Response(hit.body, { status: hit.status, headers: h })
    }

    await next()

    // Only cache 2xx JSON/text responses.
    const res = c.res
    if (!res || res.status < 200 || res.status >= 300) return
    const ct = res.headers.get('content-type') || ''
    if (!/^application\/json|^text\//.test(ct)) return

    // Clone so we can read the body without consuming it for the client.
    const cloned = res.clone()
    let body: string
    try { body = await cloned.text() } catch { return }

    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => { headers[k] = v })
    store.set(key, {
      body,
      status: res.status,
      headers,
      tag,
    }, { ttl: ttlMs })

    if (headerHint) {
      // Tag the outgoing response as a miss (the one that populated the cache).
      const newHeaders = new Headers(res.headers)
      newHeaders.set('X-Cache', 'MISS')
      c.res = new Response(body, { status: res.status, headers: newHeaders })
    }
  }
}

function defaultKey(c: Context): string {
  const url = new URL(c.req.url)
  // Sort query params so `?a=1&b=2` and `?b=2&a=1` hit the same key.
  const params = Array.from(url.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('&')
  return `${c.req.method} ${url.pathname}${params ? '?' + params : ''}`
}

/**
 * Wire common event → tag invalidations.  Call once at boot.
 */
export function installCacheInvalidators(): void {
  subscribe((event: ServerEvent) => {
    if (event.type === 'instance-changed') {
      invalidateTag('instances')
      // PR state often changes in lock-step with instance changes (push,
      // create PR, merge) — dump the HTTP-layer PR cache so the next render
      // shows the fresh draft/open/merged state.
      invalidateTag('pr')
    }
  })
}
