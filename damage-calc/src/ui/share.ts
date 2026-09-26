import LZString from 'lz-string';
import type { CalcInput } from '../engine/types';
import { sanitizeInput } from './sanitize';

const PREFIX = '#s=';

/** 共有用に、画像がないと意味のない座標などを落とす */
function forShare(input: CalcInput): CalcInput {
  return {
    ...input,
    panel: {
      ...input.panel,
      skills: input.panel.skills.map(({ bbox: _bbox, ...s }) => s),
    },
  };
}

export function encodeShareHash(input: CalcInput): string {
  return PREFIX + LZString.compressToEncodedURIComponent(JSON.stringify(forShare(input)));
}

export function decodeShareHash(hash: string): CalcInput | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const json = LZString.decompressFromEncodedURIComponent(hash.slice(PREFIX.length));
    return json ? sanitizeInput(JSON.parse(json)) : null;
  } catch {
    return null;
  }
}
