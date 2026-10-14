# PowerHub logo WebP conversion verification

- Verified at (UTC date): 2026-10-14
- Source: current original light/dark PNGs fetched from the production brand-asset proxy.
- Encoding: WebP lossless (exact=True, quality=100, method 6).
- Pixel validation: PNG and decoded WebP RGBA byte arrays are identical for each theme.
- Fallbacks: original theme-matched PNG assets remain configured in PowerHubLogo.
- Browser cache: versioned /brand-v1/ assets use a one-year immutable cache policy.

| Theme | Dimensions | Original PNG | Lossless WebP | Reduction | RGBA pixels identical | Transparent pixels |
|---|---:|---:|---:|---:|---|---|
| light | 2304 × 1536 | 2,600,046 B | 1,838,830 B | 29.28% | yes | yes |
| dark | 2304 × 1536 | 2,679,388 B | 1,874,542 B | 30.04% | yes | yes |

## SHA-256

### Light
- PNG SHA-256: da7577e782543749ed5b2f04d0c446a6f064cb66b96b5cd127dfad5d80e0aad9
- WebP SHA-256: 7f0b5c2962afdc00da9eb7a5d163267e946425ba39a60c6f0c340f14bb0be7dd

### Dark
- PNG SHA-256: e030d3dd399aa3e694473d452ddc4044d794b9b5bd22443bb8755d0147f144d7
- WebP SHA-256: f8434dec772b105eb18dd84930c7723afe06edf499ecd49fba401e12a81cad8f
