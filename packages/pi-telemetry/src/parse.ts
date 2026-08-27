// Environment/config parsing helpers shared by the otel and langfuse config
// loaders. Kept at the package root so the generic otel entry point never
// imports from the langfuse module directory.

export function parseBoolean(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes';
}

export function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function trim(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
