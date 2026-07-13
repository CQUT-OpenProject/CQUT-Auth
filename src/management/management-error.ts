export class ClientManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClientManagementError";
  }
}
