import { Module } from "@nestjs/common";
import { MockProvider } from "./mock/mock.provider.js";
import { CqutProvider } from "./cqut/cqut.provider.js";
import { ProviderRegistry } from "./provider.registry.js";

@Module({
  providers: [MockProvider, CqutProvider, ProviderRegistry],
  exports: [MockProvider, CqutProvider, ProviderRegistry]
})
export class ProvidersModule {}

