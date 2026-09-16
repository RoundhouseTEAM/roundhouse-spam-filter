"use client";

/**
 * Fires a site's lead conversions on its thank-you page — once, and only for a real lead.
 *
 * Pairs with <LeadForm thankYouPath="/thank-you">. The form sends ONLY a lead the server
 * actually delivered to `/thank-you?lead=<leadId>`; blocked spam never reaches the page.
 * This component then:
 *
 *  - does nothing without a `lead` id — a direct visit, bookmark, crawler or old ad link
 *    never counts as a conversion;
 *  - fires at most once per lead id (sessionStorage), so a refresh or Back doesn't recount;
 *  - hands the id to `onLead` to pass as the Google Ads `transaction_id`, so Ads itself
 *    also drops any repeat of the same lead;
 *  - waits for gtag before firing (up to ~5s). Firing before the tag loaded silently lost
 *    a real Irrigators conversion — exactly the number the campaigns bid on;
 *  - removes `lead` from the address bar afterwards.
 *
 * Firing here rather than in the form's submit handler also means the event isn't racing
 * the page navigation.
 *
 *   <LeadConversion onLead={(leadId) => { trackEvent(...); gtag("event", "conversion", { send_to, transaction_id: leadId }) }} />
 */

import { useEffect } from "react";

/** Read without a global declaration, which could clash with a site's own typing of gtag. */
function gtagReady(): boolean {
  return typeof (window as unknown as { gtag?: unknown }).gtag === "function";
}

const STORAGE_PREFIX = "rh_lead_converted:";
const GTAG_WAIT_MS = 5000;
const GTAG_POLL_MS = 100;

export interface LeadConversionProps {
  /** Fire the site's GA events and Google Ads conversion here. Called at most once per lead. */
  onLead: (leadId: string) => void;
  /** Query parameter carrying the lead id. Defaults to "lead". */
  param?: string;
  /** Wait for window.gtag before calling onLead. Defaults to true. */
  waitForGtag?: boolean;
}

export default function LeadConversion({ onLead, param = "lead", waitForGtag = true }: LeadConversionProps) {
  useEffect(() => {
    const url = new URL(window.location.href);
    const leadId = url.searchParams.get(param);
    if (!leadId) return;

    // Strip the id first, so a refresh can never see it again even if firing fails.
    url.searchParams.delete(param);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);

    try {
      const key = STORAGE_PREFIX + leadId;
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Storage blocked (private window): fire anyway — transaction_id still dedupes in Ads.
    }

    let cancelled = false;
    const started = Date.now();
    const fire = () => {
      if (cancelled) return;
      if (waitForGtag && !gtagReady() && Date.now() - started < GTAG_WAIT_MS) {
        window.setTimeout(fire, GTAG_POLL_MS);
        return;
      }
      try {
        onLead(leadId);
      } catch (err) {
        console.error("[lead-conversion] onLead failed", err);
      }
    };
    fire();
    return () => {
      cancelled = true;
    };
    // Runs once per page load by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export { LeadConversion };
