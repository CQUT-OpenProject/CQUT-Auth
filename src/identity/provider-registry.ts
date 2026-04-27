import type { CampusVerifierProvider } from "./types.js";
import { IdentityCoreError } from "./errors.js";

export class ProviderRegistry {
  constructor(
    private readonly providers: Map<string, CampusVerifierProvider>,
    private readonly currentProviderName?: string
  ) {}

  getCurrentProvider(): CampusVerifierProvider {
    if (!this.currentProviderName) {
      throw new IdentityCoreError("provider_not_configured", "current auth provider is not configured");
    }
    return this.getByName(this.currentProviderName);
  }

  getByName(name: string): CampusVerifierProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new IdentityCoreError("unknown_provider", `unknown auth provider: ${name}`);
    }
    return provider;
  }
}
