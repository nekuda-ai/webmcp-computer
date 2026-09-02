/*
 * QR Code generator library (TypeScript port, byte mode / ECC low subset)
 * Copyright (c) 2009 Kazuhiko Arase
 * Copyright (c) 2026 WebMCP Computer contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const DATA_CODEWORDS = [19, 34, 55, 80, 108] as const;
const ECC_CODEWORDS = [7, 10, 15, 20, 26] as const;
const BYTE_CAPACITY = [17, 32, 53, 78, 106] as const;
const ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30]] as const;

type Matrix = Array<Array<boolean | null>>;

class Bits {
  readonly values: number[] = [];

  append(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.values.push((value >>> index) & 1);
    }
  }
}

function gfTables(): { exp: number[]; log: number[] } {
  const exp = new Array<number>(512).fill(0);
  const log = new Array<number>(256).fill(0);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exp[index] = value;
    log[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < exp.length; index += 1) exp[index] = exp[index - 255] ?? 0;
  return { exp, log };
}

const GF = gfTables();

function multiply(left: number, right: number): number {
  return left === 0 || right === 0 ? 0 : GF.exp[(GF.log[left] ?? 0) + (GF.log[right] ?? 0)] ?? 0;
}

function polynomialMultiply(left: number[], right: number[]): number[] {
  const result = new Array<number>(left.length + right.length - 1).fill(0);
  for (let x = 0; x < left.length; x += 1) {
    for (let y = 0; y < right.length; y += 1) {
      result[x + y] = (result[x + y] ?? 0) ^ multiply(left[x] ?? 0, right[y] ?? 0);
    }
  }
  return result;
}

function reedSolomon(data: number[], degree: number): number[] {
  let divisor = [1];
  for (let index = 0; index < degree; index += 1) {
    divisor = polynomialMultiply(divisor, [1, GF.exp[index] ?? 0]);
  }
  const result = [...data, ...new Array<number>(degree).fill(0)];
  for (let index = 0; index < data.length; index += 1) {
    const factor = result[index] ?? 0;
    if (factor === 0) continue;
    for (let offset = 0; offset < divisor.length; offset += 1) {
      result[index + offset] = (result[index + offset] ?? 0) ^ multiply(divisor[offset] ?? 0, factor);
    }
  }
  return result.slice(data.length);
}

function codewords(text: string): { version: number; bytes: number[] } {
  const encoded = [...new TextEncoder().encode(text)];
  const versionIndex = BYTE_CAPACITY.findIndex((capacity) => encoded.length <= capacity);
  if (versionIndex === -1) throw new Error("webmcp-computer: QR URL exceeds 106-byte cap");
  const dataLength = DATA_CODEWORDS[versionIndex] ?? 0;
  const bits = new Bits();
  bits.append(0b0100, 4);
  bits.append(encoded.length, 8);
  for (const byte of encoded) bits.append(byte, 8);
  bits.append(0, Math.min(4, dataLength * 8 - bits.values.length));
  while (bits.values.length % 8 !== 0) bits.values.push(0);
  const data: number[] = [];
  for (let index = 0; index < bits.values.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | (bits.values[index + bit] ?? 0);
    data.push(byte);
  }
  for (let pad = 0; data.length < dataLength; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);
  const ecc = reedSolomon(data, ECC_CODEWORDS[versionIndex] ?? 0);
  return { version: versionIndex + 1, bytes: [...data, ...ecc] };
}

function blank(size: number): { modules: Matrix; functions: boolean[][] } {
  return {
    modules: Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null)),
    functions: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(
  modules: Matrix,
  functions: boolean[][],
  x: number,
  y: number,
  value: boolean,
): void {
  if (x < 0 || y < 0 || y >= modules.length || x >= modules.length) return;
  modules[y]![x] = value;
  functions[y]![x] = true;
}

function finder(modules: Matrix, functions: boolean[][], centerX: number, centerY: number): void {
  for (let y = -4; y <= 4; y += 1) {
    for (let x = -4; x <= 4; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunction(modules, functions, centerX + x, centerY + y, distance !== 2 && distance !== 4);
    }
  }
}

function alignment(modules: Matrix, functions: boolean[][], centerX: number, centerY: number): void {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      setFunction(modules, functions, centerX + x, centerY + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
    }
  }
}

function formatBits(mask: number): number {
  const data = (1 << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function drawFormat(modules: Matrix, functions: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  const bit = (index: number) => ((bits >>> index) & 1) !== 0;
  for (let index = 0; index <= 5; index += 1) setFunction(modules, functions, 8, index, bit(index));
  setFunction(modules, functions, 8, 7, bit(6));
  setFunction(modules, functions, 8, 8, bit(7));
  setFunction(modules, functions, 7, 8, bit(8));
  for (let index = 9; index < 15; index += 1) setFunction(modules, functions, 14 - index, 8, bit(index));
  for (let index = 0; index < 8; index += 1) setFunction(modules, functions, size - 1 - index, 8, bit(index));
  for (let index = 8; index < 15; index += 1) setFunction(modules, functions, 8, size - 15 + index, bit(index));
  setFunction(modules, functions, 8, size - 8, true);
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
}

function drawData(modules: Matrix, functions: boolean[][], bytes: number[], mask: number): void {
  const size = modules.length;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (functions[y]?.[x]) continue;
        const value = bitIndex < bytes.length * 8
          ? (((bytes[bitIndex >>> 3] ?? 0) >>> (7 - (bitIndex & 7))) & 1) !== 0
          : false;
        modules[y]![x] = value !== maskBit(mask, x, y);
        bitIndex += 1;
      }
    }
  }
}

function penalty(modules: Matrix): number {
  const size = modules.length;
  let score = 0;
  const linePenalty = (line: boolean[]) => {
    let run = 1;
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === line[index - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    if (run >= 5) score += 3 + run - 5;
    const pattern = "1011101";
    const bits = line.map(Number).join("");
    for (let index = 0; index <= bits.length - pattern.length; index += 1) {
      if (bits.slice(index, index + 7) !== pattern) continue;
      const before = bits.slice(Math.max(0, index - 4), index).padStart(4, "0");
      const after = bits.slice(index + 7, index + 11).padEnd(4, "0");
      if (before === "0000" || after === "0000") score += 40;
    }
  };
  for (let y = 0; y < size; y += 1) linePenalty(modules[y]!.map(Boolean));
  for (let x = 0; x < size; x += 1) linePenalty(modules.map((row) => Boolean(row[x])));
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y]?.[x]) dark += 1;
      if (
        x + 1 < size && y + 1 < size &&
        modules[y]?.[x] === modules[y]?.[x + 1] &&
        modules[y]?.[x] === modules[y + 1]?.[x] &&
        modules[y]?.[x] === modules[y + 1]?.[x + 1]
      ) score += 3;
    }
  }
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

export function qrMatrix(text: string): boolean[][] {
  const encoded = codewords(text);
  const size = encoded.version * 4 + 17;
  const { modules, functions } = blank(size);
  finder(modules, functions, 3, 3);
  finder(modules, functions, size - 4, 3);
  finder(modules, functions, 3, size - 4);
  for (let index = 8; index < size - 8; index += 1) {
    setFunction(modules, functions, 6, index, index % 2 === 0);
    setFunction(modules, functions, index, 6, index % 2 === 0);
  }
  const positions = ALIGNMENT[encoded.version - 1] ?? [];
  for (const y of positions) {
    for (const x of positions) {
      if (!functions[y]?.[x]) alignment(modules, functions, x, y);
    }
  }
  drawFormat(modules, functions, 0);

  let best: Matrix | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => [...row]);
    const candidateFunctions = functions.map((row) => [...row]);
    drawFormat(candidate, candidateFunctions, mask);
    drawData(candidate, candidateFunctions, encoded.bytes, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return (best ?? modules).map((row) => row.map(Boolean));
}

export function qrSvg(text: string): string {
  const matrix = qrMatrix(text);
  const margin = 4;
  const size = matrix.length + margin * 2;
  const cells: string[] = [];
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (matrix[y]?.[x]) cells.push(`M${x + margin} ${y + margin}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code for published site" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${cells.join("")}" fill="#16283d"/></svg>`;
}
