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

export function isPinterestUrl(url: string): boolean {
  return PINTEREST_DOMAINS.some((domain) => url.includes(domain));
}

