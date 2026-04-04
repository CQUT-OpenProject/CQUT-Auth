export class IdentityCoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "IdentityCoreError";
    this.code = code;
  }
}

export class RetryableProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProviderError";
  }
}
