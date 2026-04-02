export class RetryableProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProviderError";
  }
}
