export function nextUntitledName(existingNames: readonly string[]): string {
  const existing = new Set(existingNames);
  if (!existing.has("untitled")) return "untitled";
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `untitled-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}
