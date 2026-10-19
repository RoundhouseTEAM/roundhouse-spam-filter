import type { LeadConfig } from "./lead";

export interface MetaLeadConfig extends LeadConfig {
  /** Defaults to process.env.META_APP_SECRET. Checks X-Hub-Signature-256 and signs appsecret_proof. */
  appSecret?: string;
  /** Defaults to process.env.META_VERIFY_TOKEN. Must match "Verify token" in the app's Webhooks settings. */
  verifyToken?: string;
  /** System-user token with leads_retrieval. Defaults to process.env.META_LEAD_TOKEN. */
  accessToken?: string;
  /** Defaults to DEFAULT_GRAPH_VERSION. */
  graphVersion?: string;
  /**
   * The client's Facebook Page id(s). A lead for any other Page is skipped (and logged) —
   * one Meta app has one webhook URL, so it receives every subscribed Page's leads.
   * Defaults to process.env.META_PAGE_ID (comma-separated). Empty = accept every Page.
   */
  pageIds?: string[];
  /**
   * Form question key → lead field, e.g. { what_do_you_need_help_with: "service" }. Keys
   * compare ignoring case and punctuation, so the question text works too. Unmapped
   * answers (ZIP included) become "Question: answer" lines in the message.
   */
  metaFields?: Record<string, string>;
  /** Question key → label for its message line, overriding the humanized key. */
  metaLabels?: Record<string, string>;
  /**
   * Answers that are delivered AND flagged in the central log — never withheld,
   * e.g. { is_this_for_your_home: ["No, a business"] }.
   */
  metaFlagAnswers?: Record<string, string[]>;
}

export declare const DEFAULT_GRAPH_VERSION: string;
export declare function normalizeKey(key: string): string;
export declare function verifySignature(rawBody: string, header: string | null, appSecret: string): { ok: boolean; note: string };
export declare function leadgenChanges(body: unknown): Array<{
  leadgen_id: string;
  page_id: string;
  form_id?: string;
  ad_id?: string;
  adgroup_id?: string;
  created_time?: number;
}>;
export declare function mapMetaLead(
  graphLead: unknown,
  config?: Partial<MetaLeadConfig>
): { lead: Record<string, string>; answers: Array<{ key: string; label: string; value: string }> };
/** GET: Meta's webhook verification. POST: fetch each lead and deliver it like a form lead. */
export declare function handleMetaLead(req: Request, config: MetaLeadConfig): Promise<Response>;
export default handleMetaLead;
