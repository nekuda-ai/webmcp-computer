export const ASK_ANNOTATIONS = {
  readOnlyHint: true,
  consequentialHint: false,
} as const;

export const ACT_ANNOTATIONS = {
  readOnlyHint: false,
  consequentialHint: false,
} as const;

export const TRANSACT_ANNOTATIONS = {
  readOnlyHint: false,
  consequentialHint: true,
} as const;
