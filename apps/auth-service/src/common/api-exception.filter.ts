import type { Request, Response } from "express";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject, Logger } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";
import { ApiError, RateLimitError } from "./api-error.js";

type ErrorBody = {
  error: string;
  error_description: string;
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();

    if (exception instanceof ApiError) {
      if (exception instanceof RateLimitError) {
        response.setHeader("Retry-After", String(exception.retryAfterSeconds));
      }
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = this.toResponseBody(exception, status);
      response.status(status).json(body);
      return;
    }

    this.logger.error(
      JSON.stringify({
        event: "unhandled_exception",
        method: request.method,
        path: request.originalUrl,
        error: exception instanceof Error ? exception.message : "unknown error"
      })
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: "server_error",
      error_description: this.config.appEnv === "production" ? "internal server error" : "unexpected server error"
    });
  }

  private toResponseBody(exception: HttpException, status: number): ErrorBody {
    const payload = exception.getResponse();
    if (typeof payload === "object" && payload !== null) {
      const record = payload as Record<string, unknown>;
      const error = typeof record["error"] === "string" ? record["error"] : undefined;
      const description =
        typeof record["error_description"] === "string"
          ? record["error_description"]
          : this.firstMessage(record["message"]);

      if (error && description) {
        return {
          error,
          error_description: description
        };
      }
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return {
        error: "server_error",
        error_description: this.config.appEnv === "production" ? "internal server error" : "unexpected server error"
      };
    }

    if (status === HttpStatus.UNAUTHORIZED) {
      return {
        error: "invalid_client",
        error_description: this.firstMessage((payload as Record<string, unknown>)?.["message"]) ?? "client authentication failed"
      };
    }

    if (status === HttpStatus.NOT_FOUND) {
      return {
        error: "invalid_request",
        error_description: "resource not found"
      };
    }

    return {
      error: "invalid_request",
      error_description: this.firstMessage((payload as Record<string, unknown>)?.["message"]) ?? "invalid request"
    };
  }

  private firstMessage(message: unknown) {
    if (Array.isArray(message)) {
      const first = message.find((value) => typeof value === "string");
      return typeof first === "string" ? first : undefined;
    }
    return typeof message === "string" ? message : undefined;
  }
}
