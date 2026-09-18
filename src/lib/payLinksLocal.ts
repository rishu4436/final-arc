const key = (address: string) => `final-links:${address.toLowerCase()}`;

export function rememberLink(address: string, token: string) {
  const prev = readLinks(address);
  const next = [token, ...prev.filter((item) => item !== token)].slice(0, 50);
  localStorage.setItem(key(address), JSON.stringify(next));
}

export function readLinks(address: string): string[] {
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}
