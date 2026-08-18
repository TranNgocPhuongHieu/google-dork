import { Tier } from './entity_registry';
import { CadenceGroup, ProfileSpec } from './profiles/types';

export interface PageDepthInputs {
  requestedMaxPages: number;
  searchMaxPages: number;
  legacyTierMaxPages: Record<Tier, number>;
}

/** Resolve a per-query page cap without changing the legacy tier-cap path. */
export function resolveMaxPages(
  profile: ProfileSpec,
  tier: Tier,
  cadence: CadenceGroup | undefined,
  { requestedMaxPages, searchMaxPages, legacyTierMaxPages }: PageDepthInputs,
): number {
  const profileCap = cadence === undefined ? undefined : profile.pageDepth?.[tier][cadence];
  const tierCap = profileCap ?? legacyTierMaxPages[tier];
  return Math.max(1, Math.min(tierCap, requestedMaxPages, searchMaxPages));
}
