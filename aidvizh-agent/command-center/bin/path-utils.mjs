export function normalizePathKey(value, { caseInsensitive = false } = {}) {
  let text = String(value).replaceAll("\\", "/").replace(/\/+/g, "/");
  if (text.length > 1) text = text.replace(/\/+$/, "");
  return caseInsensitive ? text.toLowerCase() : text;
}

export function isPathWithin(root, candidate, { caseInsensitive = false } = {}) {
  const normalizedRoot = normalizePathKey(root, { caseInsensitive });
  const normalizedCandidate = normalizePathKey(candidate, { caseInsensitive });
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
