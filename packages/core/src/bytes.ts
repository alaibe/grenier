// Web APIs only, so these run on Node and on Workers.

export const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** `n` random bytes as hex: an id, a nonce. */
export const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Base64 that a URL, a file name or a token carries as it is: `-` and `_`, no padding. */
export const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const fromBase64Url = (text: string) => fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));
