/**
 * Per-IP submission rate limit for handleLead().
 *
 * Only DELIVERABLE submissions are counted — handleLead calls this after every spam
 * check and after the double-click guard — so bots, validation errors and blocked junk
 * never use up a real visitor's allowance. handleLead flags a lead over DEFAULT_LIMIT and
 * withholds only over DEFAULT_FLOOD_LIMIT, to stop a flood of valid-looking submissions
 * from one source reaching a client's inbox.
 *
 * NEVER BLOCKS A LEAD BECAUSE OF ITS OWN FAILURE. A missing IP, a store that is down,
 * slow or unconfigured — every one of those allows the submission.
 *
 * Store: Upstash Redis (the Vercel Marketplace "Upstash for Redis" integration) when its
 * REST env vars are present — exact across every Vercel instance. Otherwise an in-memory
 * count per instance, which still catches most floods because a burst from one IP lands
 * on the same warm instance.
 */

/** Above this many deliverable leads from one IP the lead is still delivered, but flagged. */
export const DEFAULT_LIMIT = 5;
/**
 * Above this many it is withheld (logged in full). Far beyond any office, property
 * manager or client testing their own form — only a flood reaches it.
 */
export const DEFAULT_FLOOD_LIMIT = 30;
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const REDIS_TIMEOUT_MS = 1000;

const memory = new Map(); // key -> array of timestamps (ms)

function memoryHit(key, limit, windowMs) {
  const now = Date.now();
  // Opportunistic cleanup so the map can't grow without bound.
  if (memory.size > 5000) {
    for (const [k, times] of memory) if (!times.length || now - times[times.length - 1] > windowMs) memory.delete(k);
  }
  const times = (memory.get(key) ?? []).filter((t) => now - t < windowMs);
  times.push(now);
  memory.set(key, times);
  return times.length;
}

async function redisHit(key, windowMs) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const bucket = Math.floor(Date.now() / windowMs);
  const k = `rh:lead-rate:${key}:${bucket}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", k],
        ["EXPIRE", k, String(Math.ceil(windowMs / 1000) + 5)],
      ]),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const count = Number(data?.[0]?.result);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The visitor's IP as Vercel reports it, or "" when unknown. */
export function clientIp(req) {
  try {
    const h = req?.headers;
    return ((h?.get("x-forwarded-for") ?? "").split(",")[0].trim() || h?.get("x-real-ip") || "").trim();
  } catch {
    return "";
  }
}

/**
 * @returns {Promise<{allowed: boolean, count: number, store: "redis" | "memory" | "none"}>}
 */
export async function checkRateLimit(key, { limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!key) return { allowed: true, count: 0, store: "none" };
  try {
    const redisCount = await redisHit(key, windowMs);
    if (redisCount !== null) return { allowed: redisCount <= limit, count: redisCount, store: "redis" };
    const count = memoryHit(key, limit, windowMs);
    return { allowed: count <= limit, count, store: "memory" };
  } catch {
    return { allowed: true, count: 0, store: "none" };
  }
}

/** Test hook. */
export function _resetRateLimitMemory() {
  memory.clear();
}
