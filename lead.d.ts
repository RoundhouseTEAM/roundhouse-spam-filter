import type { ExtraField } from "./validate";

export interface LeadConfig {
  /** Project slug, e.g. "power-construction-website". Identifies the site in the central log. */
  site: string;
  /** Shown in the email subject and heading, e.g. "Power Construction". */
  businessName: string;
  /** Display phone, used in the "please call us" messages, e.g. "(609) 555-0100". */
  phone: string;
  /** Domain fragments. ALWAYS include "localhost" and ".vercel.app". */
  allowedOrigins: string[];
  /** Who receives the lead email. */
  recipients: string[];
  /** Defaults to "<businessName> Leads <leads@resend.getroundhouse.com>". */
  from?: string;
  /** The client's leads sheet — linked as a button in every lead email. */
  leadsSheetUrl?: string;
  /** Prepended to the email subject, e.g. "[TEST] " for a site that hasn't launched. */
  subjectPrefix?: string;
  /** Heading and button colour in the lead email. */
  brandColor?: string;
  /** Fields beyond name / phone / email / message, e.g. address. */
  extraFields?: ExtraField[];
  /** Where a no-JavaScript visitor is redirected after submitting. Defaults to "/". */
  successPath?: string;
  /**
   * Per-IP count of DELIVERABLE submissions (counted after every spam check). Over `limit`
   * (default 5 per 10 minutes) the lead is delivered and flagged; over `floodLimit`
   * (default 30) it is withheld and logged in full. `false` disables it. Uses Upstash Redis
   * when UPSTASH_REDIS_REST_URL / _TOKEN (or KV_REST_API_URL / _TOKEN) are set, otherwise an
   * in-memory count per instance. Never withholds because of its own failure.
   */
  rateLimit?: { limit?: number; floodLimit?: number; windowMinutes?: number } | false;
  /** Whether Cyrillic/Greek is flagged in the central log. Defaults to true. Never withholds a lead. */
  nonLatin?: boolean;
  /** Defaults to process.env.GOOGLE_SHEET_WEBHOOK. */
  sheetWebhook?: string;
  /** How the client's Apps Script expects the row: JSON POST (default) or GET query params. */
  sheetMethod?: "POST" | "GET";
  /**
   * Reshape the row for the client's existing Apps Script, e.g. rename keys or add a
   * constant ({ sheet: "Brandon Google Ads" }). Receives name, phone, email, message,
   * source, every extra field, leadId and submittedAt.
   */
  sheetPayload?: (lead: Record<string, string>) => Record<string, string>;
  /** Defaults to process.env.RESEND_API_KEY. */
  resendApiKey?: string;
}

/** The entire server side of a Roundhouse contact form. */
export declare const MAX_BODY_BYTES: number;
export declare function readOpenTime(body: Record<string, unknown>): { jsRan: boolean; openMs: number | null };
export declare function automationSignals(input: {
  body: Record<string, unknown>;
  headers: Headers;
  allowedOrigins?: string[];
  jsRan: boolean;
  openMs: number | null;
}): { strong: string[]; weak: string[]; honeypot: string };
export declare function sheetAccepted(res: Response): Promise<{ ok: boolean; detail: string }>;
export declare function handleLead(req: Request, config: LeadConfig): Promise<Response>;
export default handleLead;
