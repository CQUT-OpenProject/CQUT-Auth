import type {
  ActiveOidcClientRecord,
  OidcPersistence,
} from "../persistence/contracts.js";
import {
  captureAuthorizationGeneration,
  currentAuthorizationGeneration,
} from "./authorization-context.js";

const internalGenerationKey = "__cqutAuthorizationGeneration";
const internalClientIdKey = "__cqutAuthorizationClientId";

type AdapterStore = Pick<
  OidcPersistence,
  | "upsertArtifact"
  | "findArtifact"
  | "destroyArtifact"
  | "consumeArtifact"
  | "findArtifactByUid"
  | "findArtifactByUserCode"
  | "revokeArtifactsByGrantId"
  | "findOidcClient"
>;

function providerClientMetadata(client: ActiveOidcClientRecord) {
  const metadata: Record<string, unknown> = {
    client_id: client.clientId,
    client_name: client.displayName,
    application_type: "web",
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    scope: client.scopeWhitelist.join(" "),
    allowRefreshTokenForPublicClient: client.allowRefreshTokenForPublicClient,
    clientSecretDigests: client.clientSecretDigests,
  };
  if (client.clientType === "web") {
    metadata["client_secret"] = `placeholder:${client.clientId}`;
    metadata["client_secret_expires_at"] = 0;
  }
  return metadata;
}

export function createAdapter(store: AdapterStore) {
  return class PostgresAdapter {
    readonly modelName: string;

    constructor(modelName: string) {
      this.modelName = modelName;
    }

    async upsert(
      id: string,
      payload: Record<string, unknown>,
      expiresIn: number,
    ) {
      if (this.modelName === "Client") {
        throw new Error("Client adapter upsert is disabled in managed profile");
      }
      await store.upsertArtifact(
        `${this.modelName}:${id}`,
        this.modelName,
        payload,
        expiresIn,
        typeof payload["clientId"] === "string"
          ? currentAuthorizationGeneration(payload["clientId"])
          : undefined,
      );
    }

    async find(id: string) {
      if (this.modelName === "Client") {
        const client = await store.findOidcClient(id);
        if (!client || client.lifecycleStatus !== "active") {
          return undefined;
        }
        captureAuthorizationGeneration(
          client.clientId,
          client.authorizationGeneration,
        );
        return providerClientMetadata(client);
      }
      return this.captureArtifactContext(
        await store.findArtifact(`${this.modelName}:${id}`),
      );
    }

    async findByUid(uid: string) {
      const payload = this.captureArtifactContext(
        await store.findArtifactByUid(uid, this.modelName),
      );
      if (!payload || payload["kind"] !== this.modelName) {
        return undefined;
      }
      return payload;
    }

    async findByUserCode(userCode: string) {
      return this.captureArtifactContext(
        await store.findArtifactByUserCode(userCode),
      );
    }

    async destroy(id: string) {
      await store.destroyArtifact(`${this.modelName}:${id}`);
    }

    async consume(id: string) {
      await store.consumeArtifact(`${this.modelName}:${id}`);
    }

    async revokeByGrantId(grantId: string) {
      await store.revokeArtifactsByGrantId(grantId);
    }

    captureArtifactContext(payload: Record<string, unknown> | undefined) {
      if (!payload) return undefined;
      const clientId = payload[internalClientIdKey];
      const generation = payload[internalGenerationKey];
      if (typeof clientId === "string" && typeof generation === "number") {
        captureAuthorizationGeneration(clientId, generation);
      }
      delete payload[internalClientIdKey];
      delete payload[internalGenerationKey];
      return payload;
    }
  };
}
