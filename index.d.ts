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
