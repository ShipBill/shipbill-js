// Errors from the API, as classes by their `type`, each with the API's `code`, `message`, the field at fault
// (`param`), and the `requestId` to quote to support.

export interface ErrorDetails {
  type: string;
  code: string;
  message: string;
  param?: string | null;
  request_id?: string;
}

export class ShipBillError extends Error {
  override readonly name: string = "ShipBillError";
  /** invalid_request_error, authentication_error, permission_error, rate_limit_error, idempotency_error, api_error. */
  readonly type: string;
  /** What went wrong, for your code to branch on: "resource_missing", "subscription_not_renewable", … */
  readonly code: string;
  /** The field at fault, such as "line_items.0.product". */
  readonly param: string | null;
  readonly statusCode: number | null;
  /** Quote this to ShipBill's support. */
  readonly requestId: string | null;

  constructor(details: ErrorDetails, statusCode: number | null = null, requestId: string | null = null) {
    super(details.message);
    this.type = details.type;
    this.code = details.code;
    this.param = details.param ?? null;
    this.statusCode = statusCode;
    this.requestId = details.request_id ?? requestId;
  }
}

/** A field is missing or wrong, or the thing asked for doesn't exist or can't be done now. */
export class ShipBillInvalidRequestError extends ShipBillError {
  override readonly name = "ShipBillInvalidRequestError";
}
/** The key is missing, wrong, or revoked. */
export class ShipBillAuthenticationError extends ShipBillError {
  override readonly name = "ShipBillAuthenticationError";
}
/** The key can't do this, such as a test key on live data. */
export class ShipBillPermissionError extends ShipBillError {
  override readonly name = "ShipBillPermissionError";
}
/** Too many requests: the SDK has already waited and retried. */
export class ShipBillRateLimitError extends ShipBillError {
  override readonly name = "ShipBillRateLimitError";
}
/** An Idempotency-Key was reused with a different request. */
export class ShipBillIdempotencyError extends ShipBillError {
  override readonly name = "ShipBillIdempotencyError";
}
/** Something failed on ShipBill's side. */
export class ShipBillAPIError extends ShipBillError {
  override readonly name = "ShipBillAPIError";
}

/** ShipBill couldn't be reached, after the SDK's retries. */
export class ShipBillConnectionError extends ShipBillError {
  override readonly name = "ShipBillConnectionError";
  constructor(cause: unknown) {
    super({
      type: "connection_error",
      code: "connection_failed",
      message: `Couldn't reach ShipBill: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    this.cause = cause;
  }
}

const CLASSES: Record<string, typeof ShipBillError> = {
  invalid_request_error: ShipBillInvalidRequestError,
  authentication_error: ShipBillAuthenticationError,
  permission_error: ShipBillPermissionError,
  rate_limit_error: ShipBillRateLimitError,
  idempotency_error: ShipBillIdempotencyError,
  api_error: ShipBillAPIError,
};

export async function errorFromResponse(response: Response): Promise<ShipBillError> {
  const requestId = response.headers.get("x-request-id");
  const text = await response.text().catch(() => "");
  let details: ErrorDetails | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: ErrorDetails };
    if (parsed.error && typeof parsed.error.message === "string") details = parsed.error;
  } catch {
    // Not ShipBill's error format: a proxy in between, say.
  }
  details ??= {
    type: response.status >= 500 ? "api_error" : "invalid_request_error",
    code: `http_${response.status}`,
    message: `ShipBill answered ${response.status} ${response.statusText}`.trim(),
  };
  const Class = CLASSES[details.type] ?? ShipBillError;
  return new Class(details, response.status, requestId);
}
