/* Shared with the app's app/device/code.ts, which does the same split for the
 * same reason: eight unbroken characters is a string a person loses their place
 * in halfway through, and the two screens have to show the code identically or
 * the user cannot tell they match. Duplicated rather than imported because this
 * package ships separately from the app. */
export function formatUserCode(code: string): string {
  if (code.length < 6) return code;
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}
