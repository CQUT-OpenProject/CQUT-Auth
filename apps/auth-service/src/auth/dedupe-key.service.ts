import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";

@Injectable()
export class DedupeKeyService {
  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  derive(clientId: string, schoolUid: string): string {
    const value = createHmac("sha256", this.config.dedupeKeySecret)
      .update(`${this.config.schoolCode}:${clientId}:${schoolUid}`)
      .digest("base64url");
    return `ddk_${value}`;
  }
}
