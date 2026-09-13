#!/usr/bin/env python3
"""Make launch-glyph.webp, the chip of Vector's macOS app icon for the launch
screen's glass emblem. The chip is keyed out of the icon's own art, and
launch-screen.css draws the see-through body under it.

From the repo root:

    python3 packages/app/src/features/launch/make-launch-glyph.py          # rewrite it
    python3 packages/app/src/features/launch/make-launch-glyph.py --check  # is it current?
    python3 packages/app/src/features/launch/make-launch-glyph.py --out /tmp/glyph.webp --size 336

It needs Python 3.9+ with Pillow, numpy and scipy (pip install pillow numpy
scipy). With Pillow 11.3.0 (and the libwebp it bundles), numpy 2.0.2 and scipy
1.13.1, the output is byte-identical to the committed file. Another libwebp can
encode the same pixels to other bytes, so --check then compares decoded pixels
with the recipe's own output instead.

After a new app icon: run it, look at the launch screen, then update the icon
hashes in launch-inject.test.ts.

The input is packages/desktop/icons/prod/icon.png (1024px, Display P3), the
master of icon.icns. macOS 26 scales this art into its squircle: the body box of
an NSWorkspace render is the whole art at 824/1024. So the output maps onto the
emblem's body one to one.

1. Convert Display P3 to sRGB, in float, because the browser composites in sRGB.
2. Fit the body behind the glyph: a degree-4 polynomial per channel, fitted to
   body pixels more than 60px from the glyph.
3. Find the glyph: darkness (bgL - L) / (bgL - coreL) > 0.5, then a 7px closing,
   which takes in the gloss bands inside its dark outline. Inside it the art's
   own pixels are kept, fully opaque.
4. Fit the shadow: the art's darkening of the body, as the alpha of one indigo,
   is least-squares fitted to two blurred copies of the glyph, a tight contact
   shadow and a soft drop shadow. Only the contact shadow is baked, within 40px
   of the glyph. The drop shadow would double the file, so launch-screen.css
   draws it instead (the drop-shadow on .vector-launch-glyph).
5. Resize with premultiplied Lanczos to 256px and save as WebP: quality 90,
   lossless alpha, method 6.
"""

import argparse
import base64
import io
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms
from scipy import ndimage
from scipy.optimize import nnls

HERE = Path(__file__).resolve().parent
SRC = HERE.parents[3] / "desktop" / "icons" / "prod" / "icon.png"
OUT = HERE / "launch-glyph.webp"

SIZE = 256  # covers the largest raster on a 2x display: 112px x 1.08 (exit zoom) x 2
QUALITY = 90  # WebP colour quality; alpha is always lossless
SMOOTH = 1.2  # smoothing of the measured shadow, in px at 1024
FIT_ZONE = 72  # how far out from the glyph the shadow model is fitted, px at 1024
BAKE_ZONE = 40  # how far out the baked contact shadow reaches, px at 1024
BUDGET = 10 * 1024  # launch-inject.test.ts: it is inlined into every index.html

LW = np.array([0.2126, 0.7152, 0.0722])
P3_TO_SRGB = np.array([[1.2249401, -0.2249404, 0.0], [-0.0420569, 1.0420571, 0.0], [-0.0196376, -0.0786361, 1.0982735]])


def lin(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def enc(v):
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(np.clip(v, 0, None), 1 / 2.4) - 0.055)


def design(x, y, deg=4):
    return np.stack([(x**i) * (y**j) for i in range(deg + 1) for j in range(deg + 1 - i)], -1)


def make(size):
    """Return (webp bytes, the RGBA uint8 pixels they encode)."""
    im = Image.open(SRC)
    profile = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(im.info["icc_profile"]))).strip()
    if profile != "Display P3":
        sys.exit(f"{SRC}: expected a Display P3 profile, found {profile!r}")
    p3 = np.asarray(im.convert("RGB")).astype(np.float64) / 255
    # The art has transparent rounded corners of its own: keep them out of the fit.
    art_alpha = np.asarray(im.split()[3]).astype(np.float64) / 255

    # 1. sRGB, still encoded (the browser blends encoded values)
    C = np.clip(enc(np.clip(lin(p3) @ P3_TO_SRGB.T, 0, 1)), 0, 1)
    L = C @ LW
    N = C.shape[0]
    yy, xx = np.mgrid[0:N, 0:N] / (N - 1.0)

    # 2. the body: a rough glyph mask sets the fit's exclusion zone
    rough = ndimage.binary_opening(L < 0.45, iterations=1)
    labels, n = ndimage.label(rough)
    sizes = ndimage.sum(rough, labels, range(1, n + 1))
    rough = np.isin(labels, 1 + np.nonzero(sizes > 2000)[0])
    border = np.minimum.reduce([yy, xx, 1 - yy, 1 - xx]) * (N - 1) < 24
    fit = (ndimage.distance_transform_edt(~rough) > 60) & ~border & ndimage.binary_erosion(art_alpha >= 1, iterations=4)
    X = design(xx[fit], yy[fit])
    XA = design(xx.ravel(), yy.ravel())
    coefs = [np.linalg.lstsq(X, C[..., c][fit], rcond=None)[0] for c in range(3)]
    BG = np.stack([(XA @ coefs[c]).reshape(N, N) for c in range(3)], -1)
    BGL = BG @ LW
    print("body fit rms x255:", [round(float(np.sqrt(((BG[..., c] - C[..., c])[fit] ** 2).mean()) * 255), 2) for c in range(3)])

    # 3. the glyph
    core = C[(L < 40 / 255)].mean(0)
    dark = (BGL - L) / (BGL - core @ LW)
    m0 = dark > 0.5
    labels, n = ndimage.label(m0)
    sizes = ndimage.sum(m0, labels, range(1, n + 1))
    m0 = np.isin(labels, 1 + np.nonzero(sizes > 500)[0])
    r = 7
    ky, kx = np.mgrid[-r : r + 1, -r : r + 1]
    glyph = ndimage.binary_closing(np.pad(m0, 12), structure=(kx**2 + ky**2) <= r * r)[12:-12, 12:-12]
    regions = ndimage.label(~glyph)[1]
    if regions != 3:  # outside, the ring inside the chip, the inner square's hole
        sys.exit(f"expected the glyph to split the art into 3 regions, found {regions}: the icon changed shape")

    # 4. the shadow
    dist = ndimage.distance_transform_edt(~glyph)
    near = dist < FIT_ZONE
    if art_alpha[near | glyph].min() != 1:
        sys.exit("the glyph or its shadow reaches the art's transparent corners: the icon changed shape")
    ring = (dist > 3) & (dist < 40) & ((L / BGL) < 0.9)
    K = np.zeros(3)  # the shadow's colour
    for _ in range(30):
        s = np.clip((BGL[ring] - L[ring]) / (BGL[ring] - K @ LW), 0, 1)
        K = np.array([(s * (C[ring][:, c] - BG[ring][:, c] * (1 - s))).sum() / (s * s).sum() for c in range(3)])
    K = np.clip(K, 0, 1)
    print("shadow colour (sRGB x255):", (K * 255).round(1))
    measured = ndimage.gaussian_filter(np.clip((BGL - L) / (BGL - K @ LW), 0, 1), SMOOTH)

    zone = near & ~glyph & (dist > 1.5)
    target = measured[zone]
    mask = glyph.astype(np.float64)
    cache = {}

    def blurred(sigma, down):
        if (sigma, down) not in cache:
            cache[(sigma, down)] = ndimage.gaussian_filter(ndimage.shift(mask, (down, 0), order=1, mode="constant"), sigma)
        return cache[(sigma, down)]

    best = None
    for s1 in (0.75, 1.0, 1.5, 2.5, 4):
        for s2 in (14, 18, 22, 27, 32, 40):
            for down in (8, 12, 16, 20, 24, 30):
                B = np.stack([blurred(s1, 0)[zone], blurred(s2, down)[zone]], 1)
                coef, _ = nnls(B, target)
                rms = float(np.sqrt(((B @ coef - target) ** 2).mean()))
                if best is None or rms < best[0]:
                    best = (rms, s1, s2, down, coef)
    rms, s1, s2, down, coef = best
    print(
        "shadow model: contact sigma %.2g x %.3f + drop sigma %g, %dpx down, x %.3f (rms %.4f)"
        % (s1, coef[0], s2, down, coef[1], rms)
    )
    print(
        "  the drop shadow at 112px, for launch-screen.css: blur %.2fpx, %.2fpx down, alpha %.2f"
        % (2 * s2 * 112 / 1024, down * 112 / 1024, coef[1])
    )
    shadow = np.clip(coef[0] * blurred(s1, 0), 0, 0.95)  # the contact shadow only
    shadow[(shadow < 0.012) | (dist >= BAKE_ZONE) | glyph] = 0
    shadow *= np.clip((BAKE_ZONE - dist) / 16, 0, 1)  # no hard stop at the edge of the zone

    alpha = np.where(glyph, 1.0, shadow)
    color = np.where(glyph[..., None], C, K[None, None, :])

    # 5. premultiplied Lanczos, then WebP
    pm = np.dstack([color * alpha[..., None], alpha])

    def resize(ch):
        return np.asarray(Image.fromarray(ch.astype(np.float32)).resize((size, size), Image.Resampling.LANCZOS)).astype(np.float64)

    R = np.clip(np.dstack([resize(pm[..., i]) for i in range(4)]), 0, 1)
    ra = R[..., 3]
    rc = np.where(ra[..., None] > 1e-6, np.clip(R[..., :3] / np.maximum(ra[..., None], 1e-6), 0, 1), 0)
    pixels = (np.dstack([rc, ra]) * 255 + 0.5).astype(np.uint8)
    buf = io.BytesIO()
    # exact=False: libwebp may rewrite the colour under fully transparent
    # pixels, which nobody sees, so the colour plane has no hard edges there.
    Image.fromarray(pixels).save(buf, "WEBP", quality=QUALITY, method=6, alpha_quality=100, exact=False)
    return buf.getvalue(), pixels


def compare(data, pixels):
    """How far encoded bytes are from the recipe's pixels: (alpha max diff, opaque PSNR dB)."""
    dec = np.asarray(Image.open(io.BytesIO(data)).convert("RGBA")).astype(np.float64)
    ref = pixels.astype(np.float64)
    if dec.shape != ref.shape:
        return math.inf, 0.0
    opaque = ref[..., 3] == 255
    mse = ((dec[..., :3] - ref[..., :3])[opaque] ** 2).mean()
    return float(np.abs(dec[..., 3] - ref[..., 3]).max()), 10 * math.log10(255**2 / max(mse, 1e-12))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="exit 1 unless the committed launch-glyph.webp matches the recipe")
    ap.add_argument("--out", type=Path, default=OUT, help="where to write (default: launch-glyph.webp next to this script)")
    ap.add_argument("--size", type=int, default=SIZE, help="output size in px (default %(default)s)")
    args = ap.parse_args()

    data, pixels = make(args.size)
    a_err, psnr = compare(data, pixels)
    print(
        "%dpx: %d bytes (%d as base64); opaque PSNR %.1f dB, alpha max |err| %g; %.0f%% fully transparent"
        % (args.size, len(data), len(base64.b64encode(data)), psnr, a_err, (pixels[..., 3] == 0).mean() * 100)
    )

    if args.check:
        committed = OUT.read_bytes()
        if committed == data:
            print(f"{OUT.name} is current: byte-identical to the recipe's output")
            return 0
        a_err, psnr = compare(committed, pixels)
        # Alpha is lossless, so it must match exactly. The colour is lossy
        # (q90 gives about 40 dB on the opaque pixels), so allow for another
        # encoder; a stale file misses by far more.
        ok = a_err == 0 and psnr >= 36
        print(
            f"{OUT.name} differs from the recipe's bytes (another libwebp?); decoded against its pixels: "
            f"alpha max |err| {a_err:g}, opaque PSNR {psnr:.1f} dB -> {'current' if ok else 'STALE: remake it'}"
        )
        return 0 if ok else 1

    if args.size == SIZE and len(data) >= BUDGET:
        print(f"warning: {len(data)} bytes is over the {BUDGET}-byte inline budget in launch-inject.test.ts")
    args.out.write_bytes(data)
    print("wrote", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
