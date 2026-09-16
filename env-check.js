/**
 * Fails a production build when a lead-delivery setting is missing.
 *
 * A contact form with no RESEND_API_KEY and no GOOGLE_SHEET_WEBHOOK still renders and
 * still says "thanks" — the lead just goes nowhere. The realistic way that happens is a
 * setup mistake on a new or moved Vercel project, and nobody notices until a client asks
 * where their leads went. Called from next.config, it turns that into a failed deploy.
 *
 *   import { checkLeadEnv } from "@roundhouse/spam-filter/env";
 *   checkLeadEnv();
 *
 * Production builds throw; preview and local builds only warn, so a branch preview
 * without secrets still builds.
 */
export const LEAD_ENV_VARS = ["RESEND_API_KEY", "GOOGLE_SHEET_WEBHOOK", "BLOCKED_LOG_WEBHOOK"];

export function checkLeadEnv(required = LEAD_ENV_VARS) {
  const missing = required.filter((k) => !process.env[k]);
  if (!missing.length) return;
  const msg = `[lead] Missing environment variable(s): ${missing.join(", ")} — contact form leads cannot be delivered.`;
  if (process.env.VERCEL_ENV === "production") throw new Error(msg);
  console.warn(msg);
}

export default checkLeadEnv;
