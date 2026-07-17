const BINARY_DATA_URI_PATTERN = /\bdata\s*:\s*(?:image\/[a-z0-9.+-]+|application\/(?:zip|octet-stream))(?:\s*;\s*[^,;'"`\s]+)*\s*;\s*base64\s*,/i;

export function containsForbiddenBinaryDataUri(source) {
  return typeof source === 'string' && BINARY_DATA_URI_PATTERN.test(source);
}
