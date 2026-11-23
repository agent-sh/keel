// A pairing code a person types by hand on a phone that cannot scan: eight
// characters of Crockford's base32 (no I, L, O or U), shown as two groups of
// four. 40 bits. It is good once, for the life of the pairing it belongs to,
// and only in a request the phone signed with its own key (src/integrations/
// mobile/v1.ts). Guessing is held by the pairing limiter (sig.ts): at most
// PAIR_FAILURES_TOTAL failed tries in any PAIR_WINDOW_SECS across every
// source, so a code alive for 600 s meets at most 400 guesses (one in 2.7e9
// of the space) and one alive for the longest pairing, a day, 57,600 (one in
// 1.9e7).
export const TYPED_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TYPED_LENGTH = 8;
export const TYPED_BITS = TYPED_LENGTH * 5;

// A new code, in its canonical form (no separator).
export function newTypedCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TYPED_LENGTH));
  // 256 is a multiple of 32: the low five bits of a random byte are uniform.
  return [...bytes].map((b) => TYPED_ALPHABET[b & 31]).join("");
}

// How the code is shown: ABCD-EFGH.
export const typedShown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

// What a person typed, in canonical form, or null when it is not a typed code.
// Case, spaces and dashes do not matter, and the letters Crockford's base32
// leaves out read as the digits they look like (O as 0, I and L as 1).
export function typedCodeOf(input: string): string | null {
  if (input.length > 2 * TYPED_LENGTH) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== TYPED_LENGTH) return null;
  for (const ch of s) if (!TYPED_ALPHABET.includes(ch)) return null;
  return s;
}
