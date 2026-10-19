export declare const LEAD_ENV_VARS: string[];
/** LEAD_ENV_VARS plus META_APP_SECRET, META_VERIFY_TOKEN, META_LEAD_TOKEN, META_PAGE_ID. */
export declare const META_LEAD_ENV_VARS: string[];
/** Throws on a Vercel production build when a lead-delivery env var is missing; warns otherwise. */
export declare function checkLeadEnv(required?: string[]): void;
export default checkLeadEnv;
