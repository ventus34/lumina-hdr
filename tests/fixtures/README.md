# Generated PQ fixtures

`pq-gray-512.avif` and `pq-gray-768.avif` are generated 64×64 AVIFs, not game screenshots.
Each uses 10-bit YUV 4:2:0 with full-range BT.2020 non-constant luminance, ST 2084 PQ,
and constant neutral planes: Y = 512 or 768, U = V = 512. They exercise dark PQ
classification and absolute HDR luminance readback independently of browser display output.

The raw planes were written with Python `struct.pack('<H', value)` and encoded
with FFmpeg/SVT-AV1 4.1.0 (`-pixel_format yuv420p10le -video_size 64x64`,
`-color_range pc -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc`,
`-frames:v 1 -c:v libsvtav1 -preset 11 -crf 1`; the 512 fixture used preset 12/CRF 0).
Decoded YUV planes are checked with FFmpeg to confirm the coded values.
ST 2084 EOTF of Y/1023 gives the expected absolute neutral luminance.

These fixtures are project-authored test data distributed under the repository's MIT license.

`hlg-gray-512.avif` uses the same exact 512/512/512 planes and encoder settings
with `-color_trc arib-std-b67` instead of PQ. At a fixed 1000 cd/m² display peak,
the reference HLG system gamma is 1.2; the expected neutral display luminance
is `1000 * inverseOETF(512/1023)^1.2`, with zero reference black lift.
