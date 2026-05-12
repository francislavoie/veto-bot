import rawMaps from "../config/maps.json";

interface RawMapConfig {
  maps: string[];
}

function assertValidMapConfig(value: RawMapConfig): asserts value is RawMapConfig {
  if (!Array.isArray(value.maps)) {
    throw new Error("config/maps.json must contain a `maps` array.");
  }
  if (value.maps.length !== 7) {
    throw new Error("config/maps.json must contain exactly 7 maps.");
  }
  if (new Set(value.maps).size !== value.maps.length) {
    throw new Error("config/maps.json cannot contain duplicate map names.");
  }
}

export function loadMaps(): string[] {
  const parsed = rawMaps as RawMapConfig;
  assertValidMapConfig(parsed);
  return [...parsed.maps];
}
