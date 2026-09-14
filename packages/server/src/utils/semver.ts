/**
 * Just enough semver to compare client versions against a minimum, without a
 * dependency: `major.minor.patch`, compared numerically field by field. A pre-release
 * or build suffix (`1.2.0-beta.1`, `1.2.0+abc`) is accepted and ignored for ordering,
 * which is fine for a floor check (a pre-release of 1.2.0 counts as 1.2.0).
 */

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parses `major.minor.patch[-pre][+build]`; null for anything else. */
export function parseSemver(text: string): Semver | null {
  const match = SEMVER_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}
