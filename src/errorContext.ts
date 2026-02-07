const BASE_CONTEXT_SHADOW_KEYS = new Set<string>([
  'schemaVersion',
  'name',
  'code',
  'message',
  'hint',
  'context'
]);

export function sanitizeErrorContext(
  context: Record<string, string> | undefined,
  topLevelShadowKeys: readonly string[] = []
): Record<string, string> {
  if (!context) return {};
  const disallowedKeys = new Set<string>(BASE_CONTEXT_SHADOW_KEYS);
  for (const key of topLevelShadowKeys) {
    disallowedKeys.add(key);
  }
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (disallowedKeys.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
