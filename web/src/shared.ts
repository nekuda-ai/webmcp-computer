export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`webmcp-computer: ${name} must be a finite number`);
  return value;
}
