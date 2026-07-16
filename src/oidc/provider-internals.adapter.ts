import KeyStore from "oidc-provider/lib/helpers/keystore.js";
import oidcProviderInstance from "oidc-provider/lib/helpers/weak_cache.js";

export type RawOidcProvider = any;

const wrappedHandlers = new WeakSet<(context: any) => Promise<unknown>>();

export function wrapGrantHandlers(
  provider: RawOidcProvider,
  wrap: (
    handler: (context: any) => Promise<unknown>,
    context: any,
  ) => Promise<unknown>,
) {
  const handlers: Map<string, (context: any) => Promise<unknown>> =
    oidcProviderInstance(provider).grantTypeHandlers;
  for (const [grantType, handler] of handlers) {
    if (wrappedHandlers.has(handler)) continue;
    const wrapped = (context: any) => wrap(handler, context);
    wrappedHandlers.add(wrapped);
    handlers.set(grantType, wrapped);
  }
}

export function replaceSigningKeyset(
  provider: RawOidcProvider,
  privateKeys: JsonWebKey[],
  publicKeys: JsonWebKey[],
) {
  const internals = oidcProviderInstance(provider);
  const keyStore = new KeyStore();
  for (const key of privateKeys) keyStore.add(structuredClone(key));
  internals.keystore = keyStore;
  internals.jwks = { keys: publicKeys.map((key) => structuredClone(key)) };
}

export function decorateClientFinder(
  provider: RawOidcProvider,
  decorate: (client: any) => void,
) {
  const originalFind = provider.Client.find.bind(provider.Client);
  provider.Client.find = async (id: string) => {
    const client = await originalFind(id);
    if (client) decorate(client);
    return client;
  };
}
