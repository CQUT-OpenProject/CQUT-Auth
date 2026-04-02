import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req
} from "@nestjs/common";
import type { Request } from "express";
import { ApiError } from "../common/api-error.js";
import { ClientService } from "../clients/client.service.js";
import { AuthService } from "./auth.service.js";
import { RequestIdParamDto } from "./dto/request-id-param.dto.js";
import { VerifyRequestDto } from "./dto/verify-request.dto.js";

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(ClientService) private readonly clientService: ClientService
  ) {}

  @Post("/verify")
  @HttpCode(HttpStatus.ACCEPTED)
  async verify(
    @Headers("authorization") authorization: string | undefined,
    @Req() request: Request,
    @Body() body: VerifyRequestDto
  ) {
    const client = await this.clientService.authenticateBasicHeader(authorization);
    if (!client) {
      throw new ApiError("invalid_client", "client authentication failed");
    }
    return this.authService.submitVerify({
      client,
      sourceIp: request.ip ?? request.socket.remoteAddress ?? "unknown",
      account: body.account,
      password: body.password,
      scope: body.scope ?? []
    });
  }

  @Get("/result/:requestId")
  async result(
    @Headers("authorization") authorization: string | undefined,
    @Param() params: RequestIdParamDto
  ) {
    const client = await this.clientService.authenticateBasicHeader(authorization);
    if (!client) {
      throw new ApiError("invalid_client", "client authentication failed");
    }
    return this.authService.getResult(params.requestId, client.clientId);
  }
}
