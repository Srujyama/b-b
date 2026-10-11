// Source trust filter: research only reads pages we would be willing to quote to a hospital billing office.
// Anything not on these lists (billing blogs, SEO/AI content farms, lead-gen sites) is dropped before the LLM sees it.

export type Trust = "official" | "institutional" | "untrusted";

/** Professional and research bodies that republish CMS payment data. Deliberately short. */
export const INSTITUTIONAL_DOMAINS = ["acep.org", "ama-assn.org", "aapc.com", "kff.org", "fairhealthconsumer.org", "healthcostinstitute.org"];

/** Search allowlist for Medicare payment rates (Context.dev `includeDomains`). */
export const MEDICARE_SOURCE_DOMAINS = ["cms.gov", "medicare.gov", ...INSTITUTIONAL_DOMAINS];

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** `ownerDomain` is the site of the organisation the fact is about (the hospital), which is official for its own policies and prices. */
export function trustOf(url: string, ownerDomain?: string): Trust {
  const host = hostOfUrl(url);
  if (!host) return "untrusted";
  if (host.endsWith(".gov") || (ownerDomain && under(host, ownerDomain.toLowerCase().replace(/^www\./, "")))) return "official";
  if (INSTITUTIONAL_DOMAINS.some((d) => under(host, d))) return "institutional";
  return "untrusted";
}

export const isTrusted = (url: string, ownerDomain?: string) => trustOf(url, ownerDomain) !== "untrusted";

/** True if `url` is on `domain` or one of its subdomains. */
export const isOnDomain = (url: string, domain: string) => {
  const host = hostOfUrl(url);
  return Boolean(host && under(host, domain.toLowerCase().replace(/^www\./, "")));
};
