// Browser shim for the node:zlib surface just-bash's browser bundle imports:
// gunzipSync, gzipSync, constants.
import { gunzipSync as _gunzip, gzipSync as _gzip } from "fflate";

export function gunzipSync(data: Uint8Array): Uint8Array {
  return _gunzip(data instanceof Uint8Array ? data : new Uint8Array(data));
}

export function gzipSync(data: Uint8Array): Uint8Array {
  return _gzip(data instanceof Uint8Array ? data : new Uint8Array(data));
}

export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
};

export default { gunzipSync, gzipSync, constants };
