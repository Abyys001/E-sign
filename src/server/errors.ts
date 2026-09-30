export type ErrorCode =
  | "bad_request" | "validation_failed" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid_state"
  | "rate_limited" | "payload_too_large" | "unsupported_media" | "gone" | "precondition_failed" | "elevation_required"
  | "config_missing" | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, validation_failed: 422, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, invalid_state: 409,
  rate_limited: 429, payload_too_large: 413, unsupported_media: 415, gone: 410, precondition_failed: 412, elevation_required: 403,
  config_missing: 503, internal: 500,
};

/** Errors whose message is safe to show to end users. Everything else becomes a generic 500. */
export class AppError extends Error {
  readonly status: number;
  constructor(public code: ErrorCode, message: string, public details?: unknown, public headers?: Record<string, string>) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what = "Resource") => new AppError("not_found", `${what} not found`);
export const forbidden = (msg = "You do not have permission to do that") => new AppError("forbidden", msg);
