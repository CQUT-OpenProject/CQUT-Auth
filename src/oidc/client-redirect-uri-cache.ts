import type { OidcClientRepository } from "../persistence/contracts.js";

export class ClientRedirectUriCache {
  private uris: string[] = [];
  private expiresAt = 0;
  private generation = 0;
  private pending:
    | { generation: number; promise: Promise<string[]> }
    | undefined;

  constructor(
    private readonly clients: Pick<
      OidcClientRepository,
      "listActiveOidcClientRedirectUris"
    >,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate() {
    this.expiresAt = 0;
    this.generation += 1;
  }

  async get(): Promise<string[]> {
    while (this.now() >= this.expiresAt) {
      const generation = this.generation;
      if (!this.pending || this.pending.generation !== generation) {
        this.pending = {
          generation,
          promise: this.clients.listActiveOidcClientRedirectUris(),
        };
      }
      const pending = this.pending;
      try {
        const uris = await pending.promise;
        if (generation === this.generation) {
          this.uris = uris;
          this.expiresAt = this.now() + 5_000;
        }
      } finally {
        if (this.pending === pending) this.pending = undefined;
      }
    }
    return this.uris;
  }
}
