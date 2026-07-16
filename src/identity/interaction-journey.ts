import type { OidcInteractionDetails } from "../oidc/provider.js";
import type {
  OidcArtifactRepository,
  OidcClientRepository,
  PendingInteractionLogin,
} from "../persistence/contracts.js";

export type InteractionOutcome =
  | { kind: "render"; status: number; view: string }
  | { kind: "redirect"; status: 302 | 303; location: string }
  | { kind: "finishLogin"; pending: PendingInteractionLogin }
  | { kind: "finishConsent" }
  | { kind: "denyConsent" };

export class InteractionJourney {
  constructor(
    private readonly artifacts: OidcArtifactRepository,
    private readonly clients: OidcClientRepository,
  ) {}

  async open(uid: string, details: OidcInteractionDetails) {
    const clientId =
      typeof details?.params?.client_id === "string"
        ? details.params.client_id
        : "";
    const client = clientId
      ? await this.clients.findOidcClient(clientId)
      : null;
    return {
      details,
      pending: await this.artifacts.getInteractionLogin(uid),
      autoConsent: Boolean(client?.autoConsent),
    };
  }

  submitLogin(details: OidcInteractionDetails) {
    return details;
  }

  async openProfile(uid: string, details: OidcInteractionDetails) {
    return {
      details,
      pending: await this.artifacts.getInteractionLogin(uid),
    };
  }

  async submitProfile(uid: string, details: OidcInteractionDetails) {
    return this.openProfile(uid, details);
  }

  submitConsent(action: string): InteractionOutcome | undefined {
    if (action === "approve") return { kind: "finishConsent" };
    if (action === "deny") return { kind: "denyConsent" };
    return undefined;
  }
}
