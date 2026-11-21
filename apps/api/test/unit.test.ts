import { describe, it, expect } from "vitest";
import { fingerprint, tokenize, embed, cosine, chunkMarkdown } from "../src/lib/text.js";
import { detect, robustZ } from "../src/services/anomaly.js";

describe("text utilities", () => {
  it("fingerprints log messages into stable signatures", () => {
    const a = fingerprint("TimeoutError: could not acquire connection within 3000ms (waiting 37) [order 0b9e2a1c-1111-4c2d-9e2f-123456789abc]");
    const b = fingerprint("TimeoutError: could not acquire connection within 3000ms (waiting 12) [order 7a1b2c3d-2222-4c2d-9e2f-abcdefabcdef]");
    expect(a).toBe(b);
    expect(a).toContain("<uuid>");
  });
  it("splits identifiers so config keys match prose", () => {
    expect(tokenize("poolSize acquire_timeout_ms")).toEqual(["pool", "size", "acquire", "timeout", "ms"]);
  });
  it("embeddings rank related text higher", () => {
    const q = embed("database connection pool exhausted");
    expect(cosine(q, embed("pool size too small, could not acquire connection"))).toBeGreaterThan(cosine(q, embed("email provider rate limiting newsletter")));
    expect(Math.abs(cosine(q, q) - 1)).toBeLessThan(1e-3);
  });
  it("chunks markdown by heading", () => {
    const c = chunkMarkdown("# A\nintro\n## Symptoms\nlatency\n## Fix\nrevert");
    expect(c.map((x) => x.heading)).toEqual(["A", "Symptoms", "Fix"]);
  });
});

describe("anomaly detection", () => {
  const base = Array.from({ length: 30 }, (_, i) => 0.005 + (i % 3) * 0.0005);
  it("needs two consecutive breaches", () => {
    expect(detect([...base, 0.2], { threshold: 6, minAbsoluteDelta: 0.02 }).anomalous).toBe(false);
    expect(detect([...base, 0.2, 0.22], { threshold: 6, minAbsoluteDelta: 0.02 }).anomalous).toBe(true);
  });
  it("ignores statistically large but practically tiny changes", () => {
    expect(detect([...base, 0.012, 0.013], { threshold: 6, minAbsoluteDelta: 0.02 }).anomalous).toBe(false);
  });
  it("uses robust statistics (outliers in history don't mask spikes)", () => {
    const { z } = robustZ([...base, 5, 5], 0.2);
    expect(z).toBeGreaterThan(6);
  });
});
