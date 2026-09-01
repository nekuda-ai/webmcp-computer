# Performance notes

After `a94cab2`, eager boot JavaScript (entry plus static vendor chunks) fell from
311.41 to 211.48 kB gzip (-32%); xterm (86.57 kB gzip) and the 734 kB shell WASM are
off the boot path and load only when Terminal opens. `vendor-zenfs` (96.41 kB gzip)
is the next split target; this fix round intentionally leaves it unchanged.
