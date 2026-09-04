/**
 * How a provider names itself in this section's copy.
 *
 * Rows are addressed by route id, but a directory entry also carries a display
 * name, and the two disagree for every hand-declared route and for catalog
 * routes the adapter labels. Action copy names the route once, in one place,
 * so an Edit button, the dialog it opens, and the deletion it may confirm all
 * read the same string — and so a screen reader announcing the button's label
 * finds the dialog it opened carrying that label as its name.
 */

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized provider-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}
