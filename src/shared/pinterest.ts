export const PINTEREST_DOMAINS = [
  'pinterest.com',
  'pinterest.co.uk',
  'pinterest.fr',
  'pinterest.de',
  'pinterest.es',
  'pinterest.it',
  'pinterest.jp',
  'pinterest.ca',
  'pinterest.au',
  'pinterest.in',
  'pinterest.mx',
  'pinterest.se',
  'pinterest.dk',
  'pinterest.no',
  'pinterest.pt',
  'pinterest.ru',
  'pinterest.kr',
  'pinterest.ph',
  'pinterest.nz',
  'pinterest.cl',
  'pinterest.com.mx'
] as const;

export const PINTEREST_MATCH_PATTERNS = PINTEREST_DOMAINS.map(
  (domain) => `*://*.${domain}/*`
);

// Background service worker fetches image binaries from pinimg domains for ZIP packaging.
export const PINIMG_MATCH_PATTERNS = ['*://*.pinimg.com/*', '*://pinimg.com/*'] as const;

export function isPinterestUrl(url: string): boolean {
  if (typeof url !== 'string' || !url) {
    return false;
  }

  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return PINTEREST_DOMAINS.some((domain) => {
    const normalizedDomain = domain.toLowerCase();
    return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
  });
}

