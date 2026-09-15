/**
 * Credential lifecycle policy for Illarin linked instances.
 *
 * Protocol invariants enforced here:
 * - Only one refresh per installation is ever in flight; concurrent callers
 *   coalesce onto the same in-flight promise.
 * - The replacement pair is durably persisted (single committed UPDATE)
 *   before the new access token is released to any worker.
 * - A refresh whose outcome is UNKNOWN stops the installation. The old
 *   refresh token may already be spent server-side and replaying it revokes
 *   the whole instance, so we never retry it: credentials are removed and a
 *   relink is required.
 * - Any terminal 401 removes unusable credentials and emits
 *   ILLARIN_LINK_STATE_CHANGED so every background worker stands down.
 *
 * Rate limits are the one non-terminal failure: the request was rejected
 * before the server consumed the refresh token, so credentials survive and
 * the caller retries later honoring Retry-After.
 */

import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as svc from "../services/illarin-instance.service";
import { IllarinRateLimitError, IllarinUnauthorizedError, refreshTokens } from "./api";
import type { IllarinRequestOptions } from "./api";

/** Refresh this long before expiry to absorb clock skew. Access tokens last 15 minutes. */
const EXPIRY_SKEW_MS = 90_000;

export type LinkStateReason =
  | "unauthorized"
  | "refresh_outcome_unknown"
  | "unlinked";

const inflightRefreshes = new Map<string, Promise<string | null>>();

function isExpiringSoon(expiresAtIso: string): boolean {
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - Date.now() < EXPIRY_SKEW_MS;
}

/**
 * Emit link-state change so the UI resets and background workers stop.
 * Local unlink has no remote counterpart yet: the owner revokes the matching
 * instance (by ID + displayed names) in Illarin account settings themselves.
 */
export async function handleTerminalUnauthorized(userId: string, reason: LinkStateReason): Promise<void> {
  svc.deleteInstance(userId);
  eventBus.emit(EventType.ILLARIN_LINK_STATE_CHANGED, { linked: false, reason }, userId);
}

/**
 * Return a valid access token for authenticated Illarin calls, refreshing
 * first when the stored one is inside the skew window. Returns null when the
 * user is not linked or the installation was torn down during refresh.
 * Throws IllarinRateLimitError when the refresh itself is rate limited.
 */
export async function getValidAccessToken(userId: string, options?: IllarinRequestOptions): Promise<string | null> {
  const record = await svc.getIllarinInstance(userId);
  if (!record) return null;
  if (!isExpiringSoon(record.accessTokenExpiresAt)) return record.accessToken;

  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;

  const refreshPromise = doRefresh(userId, options).finally(() => inflightRefreshes.delete(userId));
  inflightRefreshes.set(userId, refreshPromise);
  return refreshPromise;
}

/** Force one serialized rotation after an ordinary access endpoint returns 401. */
export async function refreshAccessToken(userId: string, options?: IllarinRequestOptions): Promise<string | null> {
  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;

  const refreshPromise = doRefresh(userId, options, true).finally(() => inflightRefreshes.delete(userId));
  inflightRefreshes.set(userId, refreshPromise);
  return refreshPromise;
}

export async function withAccessToken<T>(userId: string, call: (accessToken: string) => Promise<T>): Promise<T | null> {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return null;
  try {
    return await call(accessToken);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
  }

  const refreshed = await refreshAccessToken(userId);
  if (!refreshed) return null;
  try {
    return await call(refreshed);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
    await handleTerminalUnauthorized(userId, "unauthorized");
    return null;
  }
}

async function doRefresh(userId: string, options?: IllarinRequestOptions, force = false): Promise<string | null> {
  // Re-load under serialization: an earlier waiter may have already rotated.
  const record = await svc.getIllarinInstance(userId);
  if (!record) return null;
  if (!force && !isExpiringSoon(record.accessTokenExpiresAt)) return record.accessToken;

  try {
    const pair = await refreshTokens(record.illarinUrl, record.refreshToken, options);
    // Committed here BEFORE resolving — waiters never see a token whose
    // matching refresh token was not already durably stored.
    await svc.replaceTokens(userId, pair);
    return pair.accessToken;
  } catch (err) {
    if (err instanceof IllarinRateLimitError) {
      // Rejected before consumption — safe to retry later with Retry-After.
      throw err;
    }
    if (err instanceof IllarinUnauthorizedError) {
      await handleTerminalUnauthorized(userId, "unauthorized");
      return null;
    }
    // Network failure or unexpected status: outcome unknown. The old token
    // may be spent — stop instead of risking an instance-revoking replay.
    await handleTerminalUnauthorized(userId, "refresh_outcome_unknown");
    return null;
  }
}
