/** Shipping policy supplied to the generic supervisor by the CLI composition root. */
export const shippingProgressPatterns: readonly string[] = Object.freeze([
  String.raw`(?:^|[;&|]\s*)(?:git\s+(?:add|commit|push)\b|gh\s+pr\s+(?:create|merge|ready|edit|comment)\b)`,
]);
