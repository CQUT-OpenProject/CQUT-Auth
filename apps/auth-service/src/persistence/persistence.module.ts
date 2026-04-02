import { Global, Module } from "@nestjs/common";
import { PostgresService } from "./postgres.service.js";
import { RedisService } from "./redis.service.js";

@Global()
@Module({
  providers: [PostgresService, RedisService],
  exports: [PostgresService, RedisService]
})
export class PersistenceModule {}

