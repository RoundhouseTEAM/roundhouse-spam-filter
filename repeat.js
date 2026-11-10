/**
 * Repeat-lead guard for handleLead() — 2.49.0 (Philip, 2026-11-09).
 *
 * hiberchat.com sent the same pitch to the Alpha Omega form ~16 times in an hour. The
 * double-click guard only remembers a lead for 2 minutes, so every copy reached the
 * client. This remembers each DELIVERED lead for 30 days, per site:
 *
 *  - EXACT REPEAT — every field the same as a lead this site already delivered (name,
 *    phone, email, message, extra fields; case and spacing ignored) → withheld. The
 *    client already has that lead, word for word, so nothing is lost.
 *  - SAME MESSAGE, DIFFERENT DETAILS — a message of 60+ characters that this site has
 *    already delivered TWICE → the third copy onward is withheld. The second copy is
 *    still delivered, so a visitor who resubmits to correct their phone or email is
 *    never swallowed; only a bot rotating names behind one pitch is.
 *
 * Only delivered leads are recorded — a visitor retrying after a failed delivery is
 * delivered again — and the daily monitor is never recorded or checked.
 *
 * NEVER BLOCKS A LEAD BECAUSE OF ITS OWN FAILURE. A store that is down, slow or
 * unconfigured allows the lead. Store: Upstash Redis when its REST env vars are present
 * (exact across every Vercel instance, survives cold starts); otherwise in-memory per
 * instance, which still catches a burst that lands on one warm instance.
 */

import { createHash } from "node:crypto";

export const REPEAT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Messages shorter than this can be typed the same by two different people. */
export const REPEAT_MESSAGE_MIN_CHARS = 60;
/** This many delivered copies of one message are allowed; the next is withheld. */
export const REPEAT_MESSAGE_ALLOWED = 2;
const REDIS_TIMEOUT_MS = 1000;
const MEMORY_MAX_KEYS = 5000;

const memory = new Map(); // key -> { count, at }

/** Lowercase, every run of whitespace one space, trimmed — "exactly the same" to a person. */
export function normalizeText(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hash(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/**
 * The two keys for a lead. `fields` is every field a visitor fills in, in a fixed order.
 * @returns {{ exact: string, message: string | null }}
 */
export function repeatKeys(site, fields, message) {
  const msg = normalizeText(message);
  return {
    exact: `rh:lead-exact:${site}:${hash(fields.map(normalizeText).join("\u0000"))}`,
    message: msg.length >= REPEAT_MESSAGE_MIN_CHARS ? `rh:lead-msg:${site}:${hash(msg)}` : null,
  };
}

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redisPipeline(commands) {
  const env = redisEnv();
  if (!env) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function memoryCount(key) {
  if (!key) return 0;
  const v = memory.get(key);
  if (!v) return 0;
  if (Date.now() - v.at > REPEAT_WINDOW_MS) {
    memory.delete(key);
    return 0;
  }
  return v.count;
}

/**
 * Whether this lead repeats one the site already delivered.
 * @returns {Promise<{ repeat: null | "repeat-lead" | "repeat-message", matched: string, store: string }>}
 */
export async function checkRepeat(keys) {
  try {
    let exact = 0;
    let message = 0;
    let store = "memory";
    const cmds = [["GET", keys.exact], ...(keys.message ? [["GET", keys.message]] : [])];
    const r = await redisPipeline(cmds);
    if (r && r.every((x) => x && !("error" in x))) {
      exact = Number(r[0]?.result) || 0;
      message = keys.message ? Number(r[1]?.result) || 0 : 0;
      store = "redis";
    } else {
      exact = memoryCount(keys.exact);
      message = memoryCount(keys.message);
    }
    if (exact >= 1) {
      return { repeat: "repeat-lead", matched: `identical to a lead this site already delivered (${store})`, store };
    }
    if (message >= REPEAT_MESSAGE_ALLOWED) {
      return {
        repeat: "repeat-message",
        matched: `same message already delivered ${message} times with other contact details (${store})`,
        store,
      };
    }
    return { repeat: null, matched: "", store };
  } catch {
    return { repeat: null, matched: "", store: "none" };
  }
}

/** Remember a delivered lead. Never throws. */
export async function recordDelivered(keys) {
  try {
    const ttl = String(Math.ceil(REPEAT_WINDOW_MS / 1000));
    const list = [keys.exact, keys.message].filter(Boolean);
    const cmds = list.flatMap((k) => [["INCR", k], ["EXPIRE", k, ttl]]);
    await redisPipeline(cmds);
    // Memory too, always: if Redis answers the check but fails here, or is down for the
    // next check, the warm instance still knows.
    const now = Date.now();
    if (memory.size > MEMORY_MAX_KEYS) {
      for (const [k, v] of memory) if (now - v.at > REPEAT_WINDOW_MS) memory.delete(k);
      while (memory.size > MEMORY_MAX_KEYS) memory.delete(memory.keys().next().value);
    }
    for (const k of list) memory.set(k, { count: memoryCount(k) + 1, at: now });
  } catch {
    /* never blocks */
  }
}

/** Test hook. */
export function _resetRepeatMemory() {
  memory.clear();
}
