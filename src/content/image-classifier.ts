export type PinterestImageSource = 'search-result' | 'recommendation' | 'page';

type ClosestCapable = {
    closest: (selector: string) => unknown;
};

export const PINTEREST_SEARCH_RESULT_SELECTORS = [
    '[data-test-id="pinGrid"]',
    '[data-test-id="search-results"]',
    '[data-test-id="searchResult"]',
    '[data-test-id="pin-grid"]'
] as const;

export const PINTEREST_RECOMMENDATION_SELECTORS = [
    '[data-test-id*="related"]',
    '[data-test-id*="recommend"]',
    '[data-test-id*="more-like"]',
    '[aria-label*="More like this"]'
] as const;

function isPinterestSearchPage(pageUrl: string): boolean {
    try {
        return new URL(pageUrl).pathname.startsWith('/search/pins/');
    } catch {
        return /^\/search\/pins\/(?:[?#]|$)/.test(pageUrl);
    }
}

function matchesClosest(element: ClosestCapable, selectors: readonly string[]): boolean {
    return selectors.some((selector) => element.closest(selector) !== null);
}

export function classifyPinterestImage(
    pageUrl: string,
    element: ClosestCapable
): PinterestImageSource {
    if (!isPinterestSearchPage(pageUrl)) return 'page';
    if (matchesClosest(element, PINTEREST_RECOMMENDATION_SELECTORS)) return 'recommendation';
    if (matchesClosest(element, PINTEREST_SEARCH_RESULT_SELECTORS)) return 'search-result';

    // Unknown search-page containers are deliberately ineligible for automatic
    // batches. Selector drift must not turn recommendation content into results.
    return 'recommendation';
}
