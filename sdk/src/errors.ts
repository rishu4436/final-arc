export class FinalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalError";
  }
}

export class FinalConfigurationError extends FinalError {
  constructor(message: string) {
    super(message);
    this.name = "FinalConfigurationError";
  }
}

export class FinalApiError extends FinalError {
  readonly status: number;
  readonly code: string;
  /** Present on policy_denied. The SDK does not evaluate policy itself. */
  readonly reasons: readonly unknown[] | null;

  constructor(status: number, code: string, message: string, reasons: readonly unknown[] | null = null) {
    super(message);
    this.name = "FinalApiError";
    this.status = status;
    this.code = code;
    this.reasons = reasons;
  }
}

export class FinalNetworkError extends FinalError {
  constructor(message = "Network request failed.") {
    super(message);
    this.name = "FinalNetworkError";
  }
}

export class FinalTimeoutError extends FinalError {
  constructor(message = "Request timed out.") {
    super(message);
    this.name = "FinalTimeoutError";
  }
}

export class FinalWebhookSignatureError extends FinalError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FinalWebhookSignatureError";
    this.code = code;
  }
}
