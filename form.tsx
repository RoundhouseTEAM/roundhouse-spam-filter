"use client";

/**
 * Roundhouse lead form — the ONE client-side contact form for every site.
 *
 * Pairs with handleLead() in lead.js. Validation messages come from validate.js, which
 * the server also runs, so what the visitor is told always matches what the server
 * enforces.
 *
 * Built to avoid every form bug that has cost a real lead so far:
 *  - Inputs are UNCONTROLLED and there is no hidden `_ts` input. The time token lives in
 *    a React ref. A hidden input with defaultValue="" was reset by React on every
 *    re-render, erasing the timestamp — every Power Construction and Indiana Flow lead
 *    arrived flagged "JavaScript did not run" because of it.
 *  - The honeypot keeps its off-screen positioning (not display:none — some bots skip
 *    those) and is read straight from the DOM at submit, by the same name the server
 *    reads. The Brandon page read it by a stale name and could not submit for 16 days.
 *  - Conversions fire only when the server says `delivered`. Blocked spam gets the same
 *    thank-you but never counts in Google Ads.
 *  - The form still has action/method, so a visitor whose JavaScript never ran can
 *    submit natively; handleLead() answers that with a redirect or a plain page.
 *
 * Styling is passed in via `classNames` — nothing here assumes a CSS framework, because
 * Tailwind does not scan node_modules.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  MESSAGE_MAX,
  NAME_MAX,
  EMAIL_MAX,
  EXTRA_FIELD_MAX,
  validateField,
  validateLead,
  isRequiredExtra,
  suggestEmail,
  offlineMessage,
  deliveryFailedMessage,
  type ExtraField,
} from "./validate.js";

export type { ExtraField };

export interface LeadFormClassNames {
  form?: string;
  /** Wrapper for a row holding one field. */
  row?: string;
  /** Wrapper for a row holding two or more fields side by side. */
  rowMulti?: string;
  /** Wrapper around a single field's label + control + message. */
  group?: string;
  label?: string;
  /** Applied to every input, textarea and select. */
  field?: string;
  /** Added to a field that currently has an error. */
  fieldInvalid?: string;
  /** The per-field error message. */
  error?: string;
  /** The "Did you mean …?" email suggestion. */
  hint?: string;
  /** Wrapper around a checkbox field (e.g. consent). Falls back to `group`. */
  checkboxGroup?: string;
  /** The <label> wrapping a checkbox and its text. */
  checkboxLabel?: string;
  checkbox?: string;
  /** The "0 / 600" message counter. */
  counter?: string;
  /** The whole-form error (offline / delivery failed). */
  formError?: string;
  button?: string;
}

export interface LeadFormProps {
  /** Defaults to "/api/contact". */
  endpoint?: string;
  /** The business phone, shown in the offline / delivery-failed messages. */
  phone: string;
  /** Fields beyond the standard four, e.g. [{ name: "address", label: "Address" }]. */
  extraFields?: ExtraField[];
  /**
   * Fixed values sent with the submission but never shown, e.g. { service: "Water heaters" }
   * for a form on a service page. Declare the same names in the route's extraFields so
   * they reach the email and sheet. Rendered as hidden inputs WITHOUT defaultValue, so a
   * re-render can't wipe them.
   */
  hiddenValues?: Record<string, string>;
  /**
   * Field order and grouping. Each inner array is one row; two names in a row sit side
   * by side (style that with classNames.rowMulti). Defaults to one field per row:
   * name, phone, email, each extra field, message.
   */
  rows?: string[][];
  labels?: Record<string, string>;
  placeholders?: Record<string, string>;
  /** Keep labels for screen readers but hide them visually. */
  hideLabels?: boolean;
  /** Append " *" to required labels. Defaults to true. */
  requiredMark?: boolean;
  messageRows?: number;
  submitLabel?: string;
  sendingLabel?: string;
  classNames?: LeadFormClassNames;
  /** What replaces the form once the submission is accepted. */
  success: ReactNode;
  /**
   * Called only for a lead the server actually delivered — fire Google Ads / GA
   * conversions here. `leadId` is unique per lead; pass it as the Ads transaction_id.
   */
  onDelivered?: (leadId: string) => void;
}

const DEFAULT_LABELS: Record<string, string> = {
  name: "Name",
  phone: "Phone",
  email: "Email",
  message: "Message",
};

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** Off-screen, not display:none — see the header comment. */
const HONEYPOT_STYLE: CSSProperties = { position: "absolute", left: "-9999px", opacity: 0, height: 0 };

const ERROR_FALLBACK_STYLE: CSSProperties = { color: "#b91c1c", fontSize: 14, marginTop: 4 };

type Status = "idle" | "sending" | "success";

export default function LeadForm({
  endpoint = "/api/contact",
  phone,
  extraFields = [],
  hiddenValues = {},
  rows,
  labels = {},
  placeholders = {},
  hideLabels = false,
  requiredMark = true,
  messageRows = 4,
  submitLabel = "Send",
  sendingLabel = "Sending…",
  classNames: cn = {},
  success,
  onDelivered,
}: LeadFormProps) {
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);
  const openedAt = useRef(0);
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [emailHint, setEmailHint] = useState("");

  useEffect(() => {
    openedAt.current = Date.now();
    // With JavaScript running, our own messages replace the browser's validation bubbles.
    setHydrated(true);
  }, []);

  const layout =
    rows ?? [
      ["name"],
      ["phone"],
      ["email"],
      ...extraFields.filter((f) => !f.checkbox && !f.hidden).map((f) => [f.name]),
      ["message"],
      // Checkboxes (consent) read naturally last, just above the button.
      ...extraFields.filter((f) => f.checkbox && !f.hidden).map((f) => [f.name]),
    ];
  const extraByName = Object.fromEntries(extraFields.map((f) => [f.name, f]));

  const labelFor = (name: string) =>
    labels[name] ?? DEFAULT_LABELS[name] ?? extraByName[name]?.label ?? name;
  const isRequired = (name: string) =>
    name in DEFAULT_LABELS || (extraByName[name] ? isRequiredExtra(extraByName[name]) : false);
  const idFor = (name: string) => `${uid}-${name}`;
  /**
   * With labels hidden the placeholder is the only visible label, so a required field
   * must say so there — otherwise a required box ("Describe your sprinkler issue...")
   * looks optional next to one that shows " *" (Brandon, 2026-09-16).
   */
  const placeholderFor = (name: string, required: boolean) => {
    const p = placeholders[name];
    if (!p || !hideLabels || !requiredMark || !required || p.includes("*")) return p;
    return `${p} *`;
  };

  function readValues(): Record<string, string> {
    const values: Record<string, string> = {};
    const form = formRef.current;
    if (!form) return values;
    for (const [k, v] of new FormData(form).entries()) {
      if (typeof v === "string") values[k] = v;
    }
    return values;
  }

  function focusFirstError(errs: Record<string, string>) {
    const first = layout.flat().find((n) => errs[n]);
    if (first) document.getElementById(idFor(first))?.focus();
  }

  function onFieldBlur(name: string, value: string) {
    // Don't nag about an empty field the visitor merely tabbed through.
    if (!value.trim() && !errors[name]) return;
    const msg = validateField(name, value, extraFields);
    if (msg !== (errors[name] ?? "")) setErrors((prev) => ({ ...prev, [name]: msg }));
    if (name === "email") setEmailHint(msg ? "" : suggestEmail(value));
  }

  function onFieldInput(name: string, value: string) {
    // Only re-render when there's an error to clear — never on every keystroke.
    if (errors[name] && !validateField(name, value, extraFields)) {
      setErrors((prev) => ({ ...prev, [name]: "" }));
    }
    if (name === "message" && counterRef.current) {
      counterRef.current.textContent = `${value.length} / ${MESSAGE_MAX}`;
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;
    setFormError("");

    const values = readValues();
    const errs = validateLead(values, extraFields);
    if (Object.keys(errs).length) {
      setErrors(errs);
      focusFirstError(errs);
      return;
    }

    setStatus("sending");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          ...hiddenValues,
          _ts: openedAt.current,
          source: window.location.href,
        }),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);

      if (res.ok && data.ok) {
        if (data.delivered && typeof data.leadId === "string") {
          try {
            onDelivered?.(data.leadId);
          } catch (err) {
            // A broken analytics call must never stop the visitor seeing their confirmation.
            console.error("[lead-form] onDelivered failed", err);
          }
        }
        setStatus("success");
        return;
      }
      setStatus("idle");
      if (res.status === 400 && data.errors && typeof data.errors === "object") {
        setErrors(data.errors as Record<string, string>);
        focusFirstError(data.errors as Record<string, string>);
        return;
      }
      setFormError(typeof data.error === "string" ? data.error : deliveryFailedMessage(phone));
    } catch {
      setStatus("idle");
      setFormError(offlineMessage(phone));
    }
  }

  if (status === "success") {
    return (
      <div role="status" aria-live="polite">
        {success}
      </div>
    );
  }

  function renderField(name: string) {
    const extra = extraByName[name];
    if (extra?.hidden) return null;
    const id = idFor(name);
    const error = errors[name];
    const errorId = `${id}-error`;
    const required = isRequired(name);
    const fieldClass = [cn.field, error ? cn.fieldInvalid : ""].filter(Boolean).join(" ") || undefined;

    if (extra?.checkbox) {
      return (
        <div key={name} className={cn.checkboxGroup ?? cn.group}>
          <label htmlFor={id} className={cn.checkboxLabel}>
            <input
              id={id}
              name={name}
              type="checkbox"
              value="yes"
              required={required}
              className={cn.checkbox}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(ev) => onFieldInput(name, ev.currentTarget.checked ? "yes" : "")}
            />{" "}
            <span>{labelFor(name)}</span>
          </label>
          {error ? (
            <p id={errorId} className={cn.error} style={cn.error ? undefined : ERROR_FALLBACK_STYLE} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      );
    }
    const common = {
      id,
      name,
      required,
      className: fieldClass,
      placeholder: placeholderFor(name, required),
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? errorId : undefined,
      onBlur: (ev: { currentTarget: { value: string } }) => onFieldBlur(name, ev.currentTarget.value),
      onInput: (ev: { currentTarget: { value: string } }) => onFieldInput(name, ev.currentTarget.value),
    };

    let control: ReactNode;
    if (name === "message" || extra?.multiline) {
      control = (
        <textarea
          {...common}
          rows={messageRows}
          maxLength={name === "message" ? MESSAGE_MAX : extra?.maxLength ?? EXTRA_FIELD_MAX}
        />
      );
    } else if (extra?.options?.length) {
      control = (
        <select {...common} defaultValue="">
          <option value="" disabled>
            {placeholderFor(name, required) ?? `Choose your ${labelFor(name).toLowerCase()}`}
          </option>
          {extra.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    } else if (name === "phone") {
      // No `pattern`: our message is clearer than the browser's, and the server re-checks.
      control = <input {...common} type="tel" inputMode="tel" autoComplete="tel" maxLength={20} />;
    } else if (name === "email") {
      control = <input {...common} type="email" autoComplete="email" maxLength={EMAIL_MAX} />;
    } else if (name === "name") {
      control = <input {...common} type="text" autoComplete="name" maxLength={NAME_MAX} />;
    } else {
      control = (
        <input
          {...common}
          type="text"
          autoComplete={extra?.autoComplete}
          maxLength={extra?.maxLength ?? EXTRA_FIELD_MAX}
        />
      );
    }

    return (
      <div key={name} className={cn.group}>
        <label htmlFor={id} className={hideLabels ? undefined : cn.label} style={hideLabels ? VISUALLY_HIDDEN : undefined}>
          {labelFor(name)}
          {required && requiredMark ? <span aria-hidden="true"> *</span> : null}
        </label>
        {control}
        {name === "message" ? (
          <span ref={counterRef} className={cn.counter} aria-hidden="true">
            {`0 / ${MESSAGE_MAX}`}
          </span>
        ) : null}
        {name === "email" && emailHint ? (
          <button
            type="button"
            className={cn.hint}
            onClick={() => {
              const input = document.getElementById(id) as HTMLInputElement | null;
              if (input) input.value = emailHint;
              setEmailHint("");
            }}
          >
            Did you mean {emailHint}?
          </button>
        ) : null}
        {error ? (
          <p id={errorId} className={cn.error} style={cn.error ? undefined : ERROR_FALLBACK_STYLE} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      action={endpoint}
      method="post"
      noValidate={hydrated}
      onSubmit={onSubmit}
      className={cn.form}
    >
      {/* Honeypot — people never see it; bots fill it in. */}
      <input
        type="text"
        name="referral_code"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        autoComplete="off"
        tabIndex={-1}
        aria-hidden="true"
        style={HONEYPOT_STYLE}
      />

      {/* `value`, not `defaultValue`: these are constants, and a controlled hidden input is
          never reset by a re-render. They matter only to a no-JavaScript native post — the
          fetch path sends hiddenValues directly. */}
      {Object.entries(hiddenValues).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      {layout.map((row) => (
        <div key={row.join("|")} className={row.length > 1 ? cn.rowMulti : cn.row}>
          {row.map(renderField)}
        </div>
      ))}

      {formError ? (
        <p className={cn.formError} style={cn.formError ? undefined : ERROR_FALLBACK_STYLE} role="alert">
          {formError}
        </p>
      ) : null}

      <button type="submit" disabled={status === "sending"} className={cn.button}>
        {status === "sending" ? sendingLabel : submitLabel}
      </button>
    </form>
  );
}

export { LeadForm };
