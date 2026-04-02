import { Inject, Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";
import { ApiError } from "../common/api-error.js";
import { CqutProvider } from "./cqut/cqut.provider.js";
import { MockProvider } from "./mock/mock.provider.js";
import type { CampusVerifierProvider } from "./provider.types.js";

@Injectable()
export class ProviderRegistry {
  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(MockProvider) private readonly mockProvider: MockProvider,
    @Inject(CqutProvider) private readonly cqutProvider: CqutProvider
  ) {}

  getCurrentProvider(): CampusVerifierProvider {
    return this.getByName(this.config.authProvider);
  }

  getByName(name: string): CampusVerifierProvider {
    switch (name) {
      case "mock":
        return this.mockProvider;
      case "cqut":
        return this.cqutProvider;
      default:
        throw new ApiError("server_error", `unknown auth provider: ${name}`);
    }
  }
}
