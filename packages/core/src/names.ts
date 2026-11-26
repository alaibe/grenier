/** A member's name, or an app's: letters, digits and `. _ @ -`. */
export const MEMBER_NAME = /^[\w.@-]{1,64}$/;

/** A machine's name: letters, digits and `. _ -`. */
export const DEVICE_NAME = /^[\w.-]{1,40}$/;

/** The token of an `Authorization: Bearer <token>` header. */
export const bearer = (header: string | null | undefined) => /^Bearer (\S+)$/.exec(header ?? "")?.[1];

/** A folder's own name, the last part of its path: a repository's, as its top folder is named. */
export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}
