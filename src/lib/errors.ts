export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export class RetryableError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "RetryableError";
  }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
// Never log arbitrary exception messages: HTTP errors can contain the bot token or PII.
export function logError(error: unknown, updateId?: number) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "bot_update_failed",
      updateId,
      type: error instanceof Error ? error.name : "UnknownError",
      code:
        error instanceof DomainError || error instanceof RetryableError ? error.code : "INTERNAL",
    }),
  );
}
