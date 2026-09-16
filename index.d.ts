export interface SpamCheckInput {
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
}

export interface SpamVerdict {
  /** True when the submission should be withheld from email and the main Sheet. */
  blocked: boolean;
  /** Which rule fired, e.g. "email-domain", "phone", "keyword:seoMarketing", "gibberish". */
  rule?: string;
  /** The specific term or value that matched — log this so the list can be audited. */
  reason?: string;
}

export declare const BLOCKED_EMAIL_DOMAINS: string[];
export declare const BLOCKED_TLDS: string[];
export declare const BLOCKED_PHONES: string[];
export declare const SPAM_PHRASES: Record<string, string[]>;

export declare function checkSpam(input?: SpamCheckInput): SpamVerdict;
export default checkSpam;

export interface OriginCheckInput {
  /** The Origin header, "" when absent. */
  origin?: string;
  /** The Referer header, "" when absent. */
  referer?: string;
  /** Domain fragments, e.g. ["example.com", "localhost", ".vercel.app"].
   *  ALWAYS keep ".vercel.app" — preview-URL submissions are otherwise discarded. */
  allowed?: string[];
}

/**
 * Layer 3. A header must be PRESENT and allowlisted, and the referer must not point
 * at an API path — a browser posting a form sends the PAGE as the referer.
 */
export declare function checkOrigin(input?: OriginCheckInput): { ok: boolean; reason: string };

export interface ContentCheckInput {
  name?: string;
  phone?: string;
  message?: string;
  /** Whether Cyrillic/Greek is a spam signal. True for every current Roundhouse
   *  client; set false for one with a multilingual customer base. */
  nonLatin?: boolean;
  /** Only check the NAME for links; links in the message are allowed. handleLead() sets this. */
  allowMessageUrls?: boolean;
}

export interface ContentVerdict {
  blocked: boolean;
  /** "content:short-phone" | "content:url" | "content:non-latin" */
  layer?: string;
  reason?: string;
}

/** Layer 4. Each pattern returns its own layer so they can be triaged separately. */
export declare function checkContent(input?: ContentCheckInput): ContentVerdict;

export interface BlockedEntry {
  /** Project slug, e.g. "newmans-plumbing". Identifies the site in the shared sheet. */
  site: string;
  /** Which rule fired: "honeypot" | "origin" | "timing" | "content:short-phone" |
   *  "content:url" | "content:non-latin" | "missing-fields", or a checkSpam
   *  verdict.rule such as "keyword:coldOutreach". */
  layer: string;
  /** The specific term or condition that matched. */
  matched?: string;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  /** The page the submission came from. A BLANK source is the fingerprint of a
   *  script POSTing the endpoint directly rather than using the form. */
  source?: string;
  /** The request, for origin / referer / user-agent forensics. Duck-typed on
   *  `headers.get()`, so a Next.js `NextRequest` works as-is. */
  req?: { headers?: { get(name: string): string | null } };
}

/**
 * Records one blocked submission to the central Roundhouse log. It NEVER sends
 * email — all alerting is done by the Apps Script behind the sheet, so a flood of
 * spam can never consume the Resend quota that real lead emails depend on.
 *
 * Await it before returning the fake success — on serverless a fire-and-forget
 * fetch is killed when the response is sent. Never rejects.
 */
export declare function logBlocked(entry: BlockedEntry): Promise<void>;

/**
 * A name, a dialable phone and a real message together — the test for "there is a
 * lead here worth rescuing today". Exported so the same definition can be reused
 * rather than reimplemented.
 */
export declare function looksLikeRealEnquiry(row: {
  name?: string;
  phone?: string;
  message?: string;
}): boolean;
