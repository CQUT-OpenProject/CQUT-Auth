import type { Response } from "express";
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { RateLimitError } from "./api-error.js";

@Catch(RateLimitError)
export class RateLimitFilter implements ExceptionFilter {
  catch(exception: RateLimitError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader("Retry-After", String(exception.retryAfterSeconds));
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
