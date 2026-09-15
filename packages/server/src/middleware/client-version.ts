import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { CLIENT_HEADER, PROTOCOL_VERSION } from "@afk/shared";
import type { UpgradeRequiredDetails } from "@afk/shared";
import type { AppDeps, AppEnv, MinimumVersions } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { compareSemver, parseSemver } from "../utils/semver.ts";

const CLIENT_HEADER_PATTERN = /^([a-z][a-z0-9-]*)\/(\S+)$/i;

/** The status a client the server will not talk to gets; see docs/VERSIONING.md. */
export const UPGRADE_REQUIRED_STATUS = 426;

/**
 * Answers 426 Upgrade Required with the details shape every version check shares, so
 * the client prints one upgrade message whichever check failed.
 */
export function upgradeRequired(
  c: Context<AppEnv>,
  minimumVersions: MinimumVersions,
  message: string,
  yourVersion: string | null,
) {
  const details: UpgradeRequiredDetails = {
    minimumClientVersion: minimumVersions.clientVersion,
    minimumProtocolVersion: minimumVersions.protocolVersion,
    yourVersion,
  };
  return errorResponse(c, UPGRADE_REQUIRED_STATUS, message, details);
}

/** True when `version` is within the range this deployment accepts. */
export function isAcceptedProtocolVersion(version: number, minimumVersions: MinimumVersions) {
  return (
    Number.isInteger(version) &&
    version >= minimumVersions.protocolVersion &&
    version <= PROTOCOL_VERSION
  );
}

/**
 * Parses `X-Afk-Client` and rejects clients below the configured minimum with 426. Goes
 * on the routes only a client calls (create, frames, end), never on dashboard reads: a
 * browser sends no header, and a missing or malformed header here is itself a 426
 * because every real client sends one. Sets `clientVersion` on the context for the
 * handler behind it.
 */
export function clientVersion({ config }: AppDeps) {
  const { minimumVersions } = config;
  const minimum = parseSemver(minimumVersions.clientVersion);
  if (!minimum) {
    throw new Error(
      `minimum client version "${minimumVersions.clientVersion}" is not major.minor.patch semver`,
    );
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    const raw = c.req.header(CLIENT_HEADER);
    const match = raw === undefined ? null : CLIENT_HEADER_PATTERN.exec(raw.trim());
    if (!match) {
      return upgradeRequired(
        c,
        minimumVersions,
        `missing or malformed ${CLIENT_HEADER} header; expected <name>/<semver>, e.g. bash/${minimumVersions.clientVersion}`,
        null,
      );
    }

    const version = match[2]!;
    const parsed = parseSemver(version);
    if (!parsed) {
      return upgradeRequired(
        c,
        minimumVersions,
        // No quotes around the version: the bash client reads `error` with a sed that
        // stops at the first double quote.
        `${CLIENT_HEADER} version ${version} is not major.minor.patch semver`,
        version,
      );
    }
    if (compareSemver(parsed, minimum) < 0) {
      return upgradeRequired(
        c,
        minimumVersions,
        `client version ${version} is below the minimum ${minimumVersions.clientVersion}; update afk`,
        version,
      );
    }

    c.set("clientVersion", version);
    await next();
  });
}
