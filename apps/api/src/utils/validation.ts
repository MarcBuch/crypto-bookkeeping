export function isNumericString(s: string): boolean {
  return /^\d+$/.test(s);
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function parseLimit(raw: string | undefined, defaultVal = 20, max = 200): number {
  if (raw === undefined) return defaultVal;
  if (!isNumericString(raw)) {
    throw new ValidationError(`limit must be a positive integer, got: ${raw}`);
  }
  const n = parseInt(raw, 10);
  if (n < 1) {
    throw new ValidationError(`limit must be a positive integer, got: ${raw}`);
  }
  return Math.min(n, max);
}

export function parseOffset(raw: string | undefined, defaultVal = 0): number {
  if (raw === undefined) return defaultVal;
  if (!isNumericString(raw)) {
    throw new ValidationError(`offset must be a non-negative integer, got: ${raw}`);
  }
  const n = parseInt(raw, 10);
  return n;
}

export function parseTaxTransactionLabel(
  raw: string | undefined,
): "Trade" | "Transfer" | "Approval" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "Trade" || raw === "Transfer" || raw === "Approval") return raw;
  throw new ValidationError(`label must be Trade, Transfer, or Approval, got: ${raw}`);
}
