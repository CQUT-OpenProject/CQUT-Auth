import assert from "node:assert/strict";
import test from "node:test";
import { InteractionJourney } from "../src/identity/interaction-journey.js";
import type { OidcInteractionDetails } from "../src/oidc/provider.js";
import type {
  OidcArtifactRepository,
  OidcClientRepository,
} from "../src/persistence/contracts.js";

const details: OidcInteractionDetails = {
  uid: "interaction-1",
  prompt: { name: "consent", details: {} },
  params: { client_id: "client-1", scope: "openid" },
  session: { accountId: "subject-1" },
};

function createJourney(autoConsent: boolean) {
  const artifacts = {
    getInteractionLogin: async () => null,
  } as unknown as OidcArtifactRepository;
  const clients = {
    findOidcClient: async () => ({ autoConsent }),
  } as unknown as OidcClientRepository;
  return new InteractionJourney(artifacts, clients);
}

test("interaction journey resolves consent policy without HTTP side effects", async () => {
  const opened = await createJourney(true).open(details.uid, details);
  assert.equal(opened.autoConsent, true);
  assert.equal(opened.pending, null);
  assert.equal(opened.details, details);
});

test("interaction journey returns discriminated consent outcomes", () => {
  const journey = createJourney(false);
  assert.deepEqual(journey.submitConsent("approve"), {
    kind: "finishConsent",
  });
  assert.deepEqual(journey.submitConsent("deny"), { kind: "denyConsent" });
  assert.equal(journey.submitConsent("invalid"), undefined);
});
