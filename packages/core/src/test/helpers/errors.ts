export async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject");
}

export function expectError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  throw new Error(`Expected Error, got ${String(error)}`);
}
