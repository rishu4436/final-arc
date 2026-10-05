/**
 * Byte-mode QR Code, error correction M, rendered as an inline SVG.
 * Encodes only the string it is given. No new dependency.
 */

const EC_BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26,
  28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
const EC_CODEWORDS_M = [
  10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198, 216, 240, 280, 308, 338, 364, 416, 442,
  476, 504, 560, 588, 644, 700, 728, 784, 812, 868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372,
];
const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196,
  3362, 3532, 3706,
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function polyMul(p1: Uint8Array, p2: Uint8Array) {
  const coeff = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) coeff[i + j] ^= gfMul(p1[i], p2[j]);
  }
  return coeff;
}

function polyMod(dividend: Uint8Array, divisor: Uint8Array) {
  let result = new Uint8Array(dividend);
  while (result.length - divisor.length >= 0) {
    const coeff = result[0];
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], coeff);
    let offset = 0;
    while (offset < result.length && result[offset] === 0) offset++;
    result = result.slice(offset);
  }
  return result;
}

function ecPolynomial(degree: number) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) poly = polyMul(poly, new Uint8Array([1, EXP[i]]));
  return poly;
}

function rsEncode(data: Uint8Array, degree: number) {
  const gen = ecPolynomial(degree);
  const padded = new Uint8Array(data.length + degree);
  padded.set(data);
  const remainder = polyMod(padded, gen);
  const start = degree - remainder.length;
  if (start > 0) {
    const buff = new Uint8Array(degree);
    buff.set(remainder, start);
    return buff;
  }
  return remainder;
}

function bchDigit(data: number): number {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}

function formatBits(mask: number): number {
  const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
  const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
  const data = mask; // ECC M bit is 0
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function versionBits(version: number): number {
  const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
  let d = version << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (version << 12) | d;
}

function symbolSize(version: number): number {
  return version * 4 + 17;
}

function charCountBits(version: number): number {
  if (version < 10) return 8;
  return 16;
}

function pickVersion(length: number): number {
  for (let version = 1; version <= 40; version++) {
    const dataCodewords = TOTAL_CODEWORDS[version] - EC_CODEWORDS_M[version - 1];
    const capacity = Math.floor((dataCodewords * 8 - 4 - charCountBits(version)) / 8);
    if (length <= capacity) return version;
  }
  throw new Error("Payment URL is too long to encode.");
}

class Bits {
  bits: number[] = [];
  put(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  putBytes(bytes: Uint8Array) {
    for (const byte of bytes) this.put(byte, 8);
  }
  get length() {
    return this.bits.length;
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
    }
    return out;
  }
}

function alignmentCoords(version: number): number[] {
  if (version === 1) return [];
  const posCount = Math.floor(version / 7) + 2;
  const size = symbolSize(version);
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

function createCodewords(payload: Uint8Array, version: number) {
  const total = TOTAL_CODEWORDS[version];
  const ecTotal = EC_CODEWORDS_M[version - 1];
  const dataTotal = total - ecTotal;
  const blocks = EC_BLOCKS_M[version - 1];
  const blocksInGroup2 = total % blocks;
  const blocksInGroup1 = blocks - blocksInGroup2;
  const dataInGroup1 = Math.floor(dataTotal / blocks);
  const dataInGroup2 = dataInGroup1 + 1;
  const ecCount = Math.floor(total / blocks) - dataInGroup1;
  const dc: Uint8Array[] = [];
  const ec: Uint8Array[] = [];
  let offset = 0;
  let maxData = 0;
  for (let b = 0; b < blocks; b++) {
    const dataSize = b < blocksInGroup1 ? dataInGroup1 : dataInGroup2;
    const chunk = payload.slice(offset, offset + dataSize);
    dc.push(chunk);
    ec.push(rsEncode(chunk, ecCount));
    offset += dataSize;
    maxData = Math.max(maxData, dataSize);
  }
  const data = new Uint8Array(total);
  let index = 0;
  for (let i = 0; i < maxData; i++) {
    for (let r = 0; r < blocks; r++) {
      if (i < dc[r].length) data[index++] = dc[r][i];
    }
  }
  for (let i = 0; i < ecCount; i++) {
    for (let r = 0; r < blocks; r++) data[index++] = ec[r][i];
  }
  return data;
}

function encodeData(text: string, version: number) {
  const bytes = new TextEncoder().encode(text);
  const dataCodewords = TOTAL_CODEWORDS[version] - EC_CODEWORDS_M[version - 1];
  const capacityBits = dataCodewords * 8;
  const bits = new Bits();
  bits.put(0b0100, 4);
  bits.put(bytes.length, charCountBits(version));
  bits.putBytes(bytes);
  if (bits.length + 4 <= capacityBits) bits.put(0, 4);
  while (bits.length % 8 !== 0) bits.put(0, 1);
  const remaining = (capacityBits - bits.length) / 8;
  for (let i = 0; i < remaining; i++) bits.put(i % 2 ? 0x11 : 0xec, 8);
  return createCodewords(bits.toBytes(), version);
}

type Matrix = { size: number; dark: Uint8Array; reserved: Uint8Array };

function idx(size: number, row: number, col: number): number {
  return row * size + col;
}

function setModule(matrix: Matrix, row: number, col: number, dark: boolean, reserved: boolean) {
  const i = idx(matrix.size, row, col);
  matrix.dark[i] = dark ? 1 : 0;
  if (reserved) matrix.reserved[i] = 1;
}

function buildMatrix(text: string, mask: number): { matrix: Matrix; version: number } {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = symbolSize(version);
  const matrix: Matrix = { size, dark: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };

  const finder = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
  for (const [row, col] of finder) {
    for (let r = -1; r <= 7; r++) {
      if (row + r < 0 || row + r >= size) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c < 0 || col + c >= size) continue;
        const on =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setModule(matrix, row + r, col + c, on, true);
      }
    }
  }
  for (let r = 8; r < size - 8; r++) {
    const on = r % 2 === 0;
    setModule(matrix, r, 6, on, true);
    setModule(matrix, 6, r, on, true);
  }
  const coords = alignmentCoords(version);
  for (let i = 0; i < coords.length; i++) {
    for (let j = 0; j < coords.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === coords.length - 1) || (i === coords.length - 1 && j === 0)) {
        continue;
      }
      const row = coords[i];
      const col = coords[j];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const on = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          setModule(matrix, row + r, col + c, on, true);
        }
      }
    }
  }
  placeFormat(matrix, mask);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3);
      const col = (i % 3) + size - 11;
      const on = ((bits >> i) & 1) === 1;
      setModule(matrix, row, col, on, true);
      setModule(matrix, col, row, on, true);
    }
  }
  const data = encodeData(text, version);
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (!matrix.reserved[idx(size, row, cc)]) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          setModule(matrix, row, cc, dark, false);
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix.reserved[idx(size, r, c)]) continue;
      if (maskAt(mask, r, c)) matrix.dark[idx(size, r, c)] ^= 1;
    }
  }
  placeFormat(matrix, mask);
  return { matrix, version };
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
    default:
      return false;
  }
}

function placeFormat(matrix: Matrix, mask: number) {
  const size = matrix.size;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const on = ((bits >> i) & 1) === 1;
    if (i < 6) setModule(matrix, i, 8, on, true);
    else if (i < 8) setModule(matrix, i + 1, 8, on, true);
    else setModule(matrix, size - 15 + i, 8, on, true);
    if (i < 8) setModule(matrix, 8, size - i - 1, on, true);
    else if (i < 9) setModule(matrix, 8, 15 - i - 1 + 1, on, true);
    else setModule(matrix, 8, 15 - i - 1, on, true);
  }
  setModule(matrix, size - 8, 8, true, true);
}

/** Module grid for tests. Mask 0, byte mode, ECC M. */
export function paymentQrModules(text: string): { size: number; dark: Uint8Array } {
  if (!text) throw new Error("QR text is required.");
  const { matrix } = buildMatrix(text, 0);
  return { size: matrix.size, dark: matrix.dark };
}

/** SVG of the checkout URL only. */
export function paymentQrSvg(text: string): string {
  const { size, dark } = paymentQrModules(text);
  const quiet = 4;
  const dim = size + quiet * 2;
  let rects = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!dark[r * size + c]) continue;
      rects += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="Payment link QR code"><rect width="${dim}" height="${dim}" fill="#fbf6ec"/>${rects.replaceAll("<rect ", '<rect fill="#161310" ')}</svg>`;
}
