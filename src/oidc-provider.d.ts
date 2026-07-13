declare module "oidc-provider";

declare module "oidc-provider/lib/helpers/weak_cache.js" {
  const instance: (provider: any) => any;
  export default instance;
}

declare module "oidc-provider/lib/helpers/keystore.js" {
  const KeyStore: any;
  export default KeyStore;
}
