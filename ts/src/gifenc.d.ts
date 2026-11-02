declare module "gifenc/dist/gifenc.esm.js" {
  export class GIFEncoder {
    constructor(opts?: { auto?: boolean });
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts: { palette: number[][]; delay?: number; repeat?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string,
  ): Uint8Array;
}
