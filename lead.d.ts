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
  /** Heading and button colour in the lead email. */
  brandColor?: string;
  /** Fields beyond name / phone / email / message, e.g. address. */
  extraFields?: ExtraField[];
  /** Where a no-JavaScript visitor is redirected after submitting. Defaults to "/". */
  successPath?: string;
  /** Whether Cyrillic/Greek is a spam signal. Defaults to true. */
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
export declare function handleLead(req: Request, config: LeadConfig): Promise<Response>;
export default handleLead;
