/** A person: their initials in ink, in a circle, so they are never mistaken for an agent or a machine. */
export function Avatar({ name, size = 20 }: { name: string; size?: 16 | 20 | 28 | 40 }) {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
  return (
    <span className={size === 28 ? "avatar" : `avatar avatar-${size}`} aria-hidden="true">
      {initials}
    </span>
  );
}
