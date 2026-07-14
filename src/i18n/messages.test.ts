import {describe, expect, it} from "vitest";

import en from "@/messages/en.json";
import fa from "@/messages/fa.json";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }

  return Object.entries(value).flatMap(([key, nested]) =>
    keyPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

describe("locale messages", () => {
  it("keeps Persian and English dictionaries structurally identical", () => {
    expect(keyPaths(en).sort()).toEqual(keyPaths(fa).sort());
  });
});

