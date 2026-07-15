export function createPinterestSearchFixture(
  resultCount: number,
  recommendationCount: number,
  imageBaseUrl: string
): string {
  const entries: string[] = [];
  let recommendationIndex = 1;

  for (let index = 1; index <= resultCount; index++) {
    entries.push(cardMarkup('result', index, imageBaseUrl));
    if (recommendationIndex <= recommendationCount && index % 16 === 0) {
      entries.push(`<section data-test-id="related-pins">${cardMarkup('recommendation', recommendationIndex, imageBaseUrl)}</section>`);
      recommendationIndex++;
    }
  }
  while (recommendationIndex <= recommendationCount) {
    entries.push(`<section data-test-id="related-pins">${cardMarkup('recommendation', recommendationIndex, imageBaseUrl)}</section>`);
    recommendationIndex++;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PinPinto deterministic search</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      [data-test-id="pinGrid"] { display: grid; grid-template-columns: repeat(4, 220px); gap: 16px; padding: 16px; }
      [data-test-id="pin"] { width: 220px; min-height: 250px; }
      img { display: block; width: 220px; height: 220px; object-fit: cover; }
    </style>
  </head>
  <body>
    <main data-test-id="pinGrid">${entries.join('')}</main>
  </body>
</html>`;
}

export function fixtureImageSvg(url: string): string {
  const label = new URL(url).pathname.split('/').pop() ?? 'image';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
    <rect width="240" height="240" fill="#e9ecef"/>
    <text x="16" y="124" font-family="Arial" font-size="16" fill="#212529">${escapeXml(label)}</text>
  </svg>`;
}

function cardMarkup(kind: 'result' | 'recommendation', index: number, imageBaseUrl: string): string {
  const padded = String(index).padStart(3, '0');
  const title = kind === 'result' ? `Result ${padded}` : `Recommendation ${padded}`;
  return `<article data-test-id="pin">
    <h2 data-test-id="pin-title">${title}</h2>
    <img src="${imageBaseUrl}/pinimg.com/236x/pinpinto-e2e/${kind}-${padded}.svg" width="220" height="220" alt="${title}">
  </article>`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  })[character] ?? character);
}
