// End-to-end encryption for the `me` top folder: the key stays on the user's devices, the server stores only sealed bytes.

const VERSION = 1;
const IV_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export class VaultError extends Error {
  override name = "VaultError";
}

/** A new random 256-bit key, as the text the user copies to their other devices. */
export function newVaultKey(): string {
  return `gv1_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function importKey(key: string): ReturnType<typeof crypto.subtle.importKey> {
  const match = /^gv1_([\w-]{43})$/.exec(key.trim());
  if (!match) throw new VaultError("not a vault key: it starts with gv1_ and has 43 more characters");
  return crypto.subtle.importKey("raw", fromBase64Url(match[1] as string), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** The name is authenticated too, so one sealed object cannot be swapped for another. */
export async function seal(key: string, name: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) },
      await importKey(key),
      plaintext,
    ),
  );
  const sealed = new Uint8Array(1 + IV_BYTES + ciphertext.length);
  sealed[0] = VERSION;
  sealed.set(iv, 1);
  sealed.set(ciphertext, 1 + IV_BYTES);
  return sealed;
}

/** Decrypts what `seal` made for the same name. Throws VaultError for another key, another name, or any change. */
export async function open(key: string, name: string, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed[0] !== VERSION || sealed.length < 1 + IV_BYTES + 16) throw new VaultError(`${name} is not a vault object`);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.slice(1, 1 + IV_BYTES), additionalData: new TextEncoder().encode(name) },
        await importKey(key),
        sealed.slice(1 + IV_BYTES),
      ),
    );
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError(`${name} cannot be decrypted with this key, or was changed`);
  }
}
