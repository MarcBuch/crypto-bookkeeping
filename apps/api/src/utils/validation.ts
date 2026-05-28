export function isNumericString(s: string): boolean {
  return /^\d+$/.test(s);
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function parseLimit(
  raw: string | undefined,
  defaultVal = 20,
  max = 200
): number {
  if (raw === undefined) return defaultVal;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) {
    throw new ValidationError(
      `limit must be a positive integer, got: ${raw}`
    );
  }
  return Math.min(n, max);
}
