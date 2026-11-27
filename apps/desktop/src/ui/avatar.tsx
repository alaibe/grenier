/** A person: their initials in ink, in a circle, so they are never mistaken for an agent or a machine. */
export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
  return (
    <span className="avatar avatar-20" aria-hidden="true">
      {initials}
    </span>
  );
}
