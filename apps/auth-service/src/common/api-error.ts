import type { ApiErrorCode } from "@cqut/shared";
import { HttpException, HttpStatus } from "@nestjs/common";

const STATUS_MAP: Record<string, HttpStatus> = {
  invalid_request: HttpStatus.BAD_REQUEST,
  invalid_client: HttpStatus.UNAUTHORIZED,
  invalid_scope: HttpStatus.BAD_REQUEST,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  verification_failed: HttpStatus.FORBIDDEN,
  server_error: HttpStatus.INTERNAL_SERVER_ERROR
};

type ApiErrorOptions = {
  responseBody?: Record<string, unknown>;
};

export class ApiError extends HttpException {
  readonly code: ApiErrorCode | string;
  readonly description: string;
  readonly responseBody: Record<string, unknown>;

  constructor(code: ApiErrorCode | string, description: string, options: ApiErrorOptions = {}) {
    const responseBody = {
      error: code,
      error_description: description,
      ...options.responseBody
    };
    super(responseBody, STATUS_MAP[code] ?? HttpStatus.BAD_REQUEST);
    this.code = code;
    this.description = description;
    this.responseBody = responseBody;
  }
}

export class RateLimitError extends ApiError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("rate_limited", "verification rate limit exceeded", {
      responseBody: {
        retry_after_seconds: retryAfterSeconds
      }
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
