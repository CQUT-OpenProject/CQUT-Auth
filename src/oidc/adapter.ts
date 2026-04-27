import type { OidcClientRecord, OidcPersistence } from "../persistence/contracts.js";

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

function providerClientMetadata(client: OidcClientRecord) {
  const metadata: Record<string, unknown> = {
    client_id: client.clientId,
    application_type: client.applicationType === "native" ? "native" : "web",
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    scope: client.scopeWhitelist.join(" "),
    clientSecretDigest: client.clientSecretDigest
  };
  if (client.clientSecretDigest) {
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

    async upsert(id: string, payload: Record<string, unknown>, expiresIn: number) {
      if (this.modelName === "Client") {
        throw new Error("Client adapter upsert is disabled in managed profile");
      }
      await store.upsertArtifact(`${this.modelName}:${id}`, this.modelName, payload, expiresIn);
    }

    async find(id: string) {
      if (this.modelName === "Client") {
        const client = await store.findOidcClient(id);
        if (!client || client.status !== "active") {
          return undefined;
        }
        return providerClientMetadata(client);
      }
      return store.findArtifact(`${this.modelName}:${id}`);
    }

    async findByUid(uid: string) {
      const payload = await store.findArtifactByUid(uid, this.modelName);
      if (!payload || payload["kind"] !== this.modelName) {
        return undefined;
      }
      return payload;
    }

    async findByUserCode(userCode: string) {
      return store.findArtifactByUserCode(userCode);
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
  };
}
