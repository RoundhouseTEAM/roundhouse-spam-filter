export interface MetaRouterConfig {
  /** Facebook Page id → that client site's handleMetaLead URL (e.g. "https://site.com/api/meta-lead/"). */
  routes: Record<string, string>;
  /** Defaults to process.env.META_APP_SECRET. Verifies Meta's signature; re-signs a split body only if it verified. */
  appSecret?: string;
  /** Defaults to process.env.META_VERIFY_TOKEN. Must match "Verify token" in the app's Webhooks settings. */
  verifyToken?: string;
  /** How long to wait on each site. Default 55000. */
  forwardTimeoutMs?: number;
}

export declare function splitByRoute(
  body: unknown,
  routes: Record<string, string>
): {
  groups: Map<string, { pages: Set<string>; entries: unknown[]; count: number }>;
  unrouted: Array<Record<string, string>>;
  total: number;
};
/** GET: Meta's webhook verification. POST: forward each lead to its Page's site. */
export declare function routeMetaLead(req: Request, config: MetaRouterConfig): Promise<Response>;
export default routeMetaLead;
