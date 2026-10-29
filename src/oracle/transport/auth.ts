/** Build a `Basic …` Authorization header value (browser + Node). From trino-monaco's `basicAuth`. */
export function basicAuthHeader(user: string, password: string): string {
  const raw = `${user}:${password}`;
  const g = globalThis as {
    btoa?: (s: string) => string;
    Buffer?: { from(s: string, enc: string): { toString(enc: string): string } };
  };
  // btoa only takes Latin-1: encode UTF-8 first so non-ASCII passwords work.
  const b64 = g.Buffer
    ? g.Buffer.from(raw, "utf8").toString("base64")
    : g.btoa!(String.fromCharCode(...new TextEncoder().encode(raw)));
  return `Basic ${b64}`;
}
