import { gunzipSync as fflateGunzip, gzipSync as fflateGzip } from "fflate";

type BinaryInput = Uint8Array | ArrayBuffer | ArrayBufferView;

function asUint8Array(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

export function gzipSync(input: BinaryInput): Uint8Array {
  return fflateGzip(asUint8Array(input));
}

export function gunzipSync(input: BinaryInput): Uint8Array {
  return fflateGunzip(asUint8Array(input));
}

export const constants = {
  Z_NO_FLUSH: 0,
  Z_SYNC_FLUSH: 2,
  Z_FINISH: 4,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_DEFAULT_COMPRESSION: -1,
};
