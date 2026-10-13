/** How the engine names a dashboard user's sandboxes: "dashboard:<account id>". */
const PREFIX = 'dashboard:';

export const ownerSubjectOf = (userId: string): string => `${PREFIX}${userId}`;

/** The account id in an owner subject, or null for any other kind. */
export function userOfOwnerSubject(subject: unknown): string | null {
  return typeof subject === 'string' && subject.startsWith(PREFIX) ? subject.slice(PREFIX.length) : null;
}
