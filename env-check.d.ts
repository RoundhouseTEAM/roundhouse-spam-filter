export declare const LEAD_ENV_VARS: string[];
/** Throws on a Vercel production build when a lead-delivery env var is missing; warns otherwise. */
export declare function checkLeadEnv(required?: string[]): void;
export default checkLeadEnv;
