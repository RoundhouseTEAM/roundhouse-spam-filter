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

export interface BlockedEntry {
  /** Project slug, e.g. "newmans-plumbing". Identifies the site in the shared sheet. */
  site: string;
  /** Which rule fired: "honeypot" | "origin" | "timing" | "content" | "missing-fields",
   *  or a checkSpam verdict.rule such as "keyword:coldOutreach". */
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
 * Records one blocked submission to the central Roundhouse log, and emails
 * Roundhouse for the layers where false positives actually occur.
 *
 * Await it before returning the fake success — on serverless a fire-and-forget
 * fetch is killed when the response is sent. Never rejects.
 */
export declare function logBlocked(entry: BlockedEntry): Promise<void>;
