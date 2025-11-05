/** Mapping from license shorthand to canonical reference URLs. */
const urls = {
  'cc-0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'cc-by-sa': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'cc-by': 'https://creativecommons.org/licenses/by/4.0/'
} as const;

/** Supported license identifiers. */
type LicenseKey = keyof typeof urls;

/** Returns the canonical license URL when a known key is provided. */
export default function getLicenseURL(license: string | null | undefined): string | undefined {
  if (!license)
    return undefined;
  const normalized = license.toLowerCase() as LicenseKey | string;
  if ((normalized as LicenseKey) in urls)
    return urls[normalized as LicenseKey];
  return undefined;
}
