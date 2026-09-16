export interface ExtraField {
  /** The submitted field name, e.g. "address". Also the key in the leads sheet payload. */
  name: string;
  /** Visible label, e.g. "Address". Used in messages ("Please enter your address."). */
  label?: string;
  required?: boolean;
  /** Defaults to 200. */
  maxLength?: number;
  /** When set, the value must be one of these (rendered as a select). */
  options?: string[];
  /** Rendered as a textarea instead of a single-line input. */
  multiline?: boolean;
  autoComplete?: string;
}

export declare const MESSAGE_MAX: number;
export declare const NAME_MAX: number;
export declare const EMAIL_MAX: number;
export declare const EXTRA_FIELD_MAX: number;
export declare const STANDARD_FIELDS: string[];
export declare const MESSAGES: Record<string, string>;

export declare function offlineMessage(phone: string): string;
export declare function deliveryFailedMessage(phone: string): string;
export declare function normalizePhone(raw: unknown): string;
export declare function validateField(name: string, value: unknown, extraFields?: ExtraField[]): string;
export declare function validateLead(values?: Record<string, unknown>, extraFields?: ExtraField[]): Record<string, string>;
export declare function suggestEmail(value: unknown): string;
