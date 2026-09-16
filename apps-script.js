/**
 * Calling a Google Apps Script web app from a serverless function — reliably.
 *
 * HOW APPS SCRIPT ANSWERS
 * ───────────────────────
 * A POST (or GET) to a /exec URL runs doPost/doGet to completion, and only THEN does
 * Google answer — with a 302 to a script.googleusercontent.com URL holding the output.
 * Reading the result is a second request.
 *
 * WHY NOT JUST `redirect: "follow"` (2026-09-16)
 * ───────────────────────────────────────────────
 * From Vercel, the script itself routinely takes 20–30s to run, and following the
 * redirect was seen to hang past 55s. With one timeout around the whole round trip, a
 * row that WAS written looked like a failure. So the two steps are timed separately:
 *
 *   1. the run   — a 302 back means the script finished;
 *   2. the read  — a short separate timeout. If it can't be read, the result is
 *                  "ran, answer unread" (`unread: true`), never "failed".
 *
 * Whether the script SUCCEEDED is still only known from the output ({ok:true}): a script
 * that throws answers with a 302 too.
 */

const DEFAULT_READ_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} url
 * @param {RequestInit} options  method, headers, body — `redirect` is set here
 * @param {{ runTimeoutMs: number, readTimeoutMs?: number }} timeouts
 * @returns {Promise<{ response: Response | null, ran: boolean, unread: boolean, status: number, detail: string }>}
 *   `response` is the response to read the script's answer from (the output page, or a
 *   direct answer); null when the script didn't run or its answer couldn't be read.
 */
export async function callAppsScript(url, options, { runTimeoutMs, readTimeoutMs = DEFAULT_READ_TIMEOUT_MS }) {
  let first;
  try {
    first = await fetchWithTimeout(url, { ...options, redirect: "manual" }, runTimeoutMs);
  } catch (err) {
    const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
    return {
      response: null,
      ran: false,
      unread: false,
      status: 0,
      detail: timedOut ? `no answer within ${Math.round(runTimeoutMs / 1000)}s` : `request failed: ${String(err).slice(0, 160)}`,
    };
  }

  const location = first.headers.get("location");
  if (first.status >= 300 && first.status < 400 && location) {
    try {
      const output = await fetchWithTimeout(location, { method: "GET" }, readTimeoutMs);
      return { response: output, ran: true, unread: false, status: output.status, detail: "" };
    } catch (err) {
      return {
        response: null,
        ran: true,
        unread: true,
        status: first.status,
        detail: `the script ran but its answer couldn't be read within ${Math.round(readTimeoutMs / 1000)}s`,
      };
    }
  }
  // Answered directly (not Apps Script, or an error before the script ran).
  return { response: first, ran: first.ok, unread: false, status: first.status, detail: first.ok ? "" : `HTTP ${first.status}` };
}

/**
 * Lets work continue after the response is sent, where the platform supports it.
 * On Vercel this is the same request-context `waitUntil` that @vercel/functions uses:
 * the function stays alive (up to maxDuration) until the promise settles. Anywhere else
 * — local dev, tests — the promise is simply awaited.
 *
 * @param {Promise<unknown>} promise
 * @returns {Promise<void>} resolves immediately when handed to the platform
 */
export async function afterResponse(promise) {
  try {
    const ctx = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(promise.catch(() => {}));
      return;
    }
  } catch {
    /* fall through to awaiting */
  }
  await promise.catch(() => {});
}
