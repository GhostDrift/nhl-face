"""Builds the team logos: faded ones for behind the goal banner, and full color
ones for when the NHL block shows the logo on its own.

Downloads each team's logo from the NHL and fits it to the NHL block's panel on
each color platform. The faded logo is reduced to one color plus transparent,
with the logo's dark, mid, and light tones dithered solid, half, and a quarter.
The watch colors it one step off the panel color, so the logo works on any team
colors. The color logo keeps the logo's main colors, as the watch shows them.
The NHL's version for dark backgrounds is kept too where it differs, for dark
panels. Also writes src/c/logos.h, which maps team abbreviations to the logo
resources, and the resource list in package.json.

Run from the project root:
  uv run --no-project --with resvg-py --with pillow python tools/make_logos.py
"""
import io
import json
import math
from collections import Counter
import re
import urllib.request

import resvg_py
from PIL import Image

URL = 'https://assets.nhle.com/logos/nhl/svg/{}_{}.svg'
# Largest logo that fits the banner's panel below the team name, per platform.
SIZES = {'basalt': (112, 80), 'emery': (160, 112)}

# Whether to set a pixel in the logo's dark, mid, and light tones. The watch's
# colors are too coarse to fade three ways, so lighter tones are dithered.
TONES = [
    lambda x, y: True,
    lambda x, y: (x + y) % 2 == 0,
    lambda x, y: x % 2 == 0 and y % 2 == 0,
]

# Share of a color logo a color must cover to be one of its main colors.
MIN_SHARE = 0.005


def teams():
    with open('src/pkjs/teams.js') as f:
        return re.findall(r'^\s+([A-Z]{3}):', f.read(), re.M)


def render(svg, size):
    # Render big, crop to the artwork, then scale down to fit.
    png = resvg_py.svg_to_bytes(svg_string=svg, width=960)
    big = Image.open(io.BytesIO(bytes(png))).convert('RGBA')
    big = big.crop(big.getchannel('A').getbbox())
    big.thumbnail(size, Image.LANCZOS)
    return big


def quantize(im):
    out = Image.new('P', im.size, 0)
    # Entry 0 is transparent; the watch sets entry 1's color.
    out.putpalette([0, 0, 0, 255, 255, 255])
    px, opx = im.load(), out.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b, a = px[x, y]
            if a < 128:
                continue
            lum = (r * 299 + g * 587 + b * 114) / 255000
            tone = min(int(lum * len(TONES)), len(TONES) - 1)
            if TONES[tone](x, y):
                opx[x, y] = 1
    out.info['transparency'] = 0
    return out


def oklab(rgb):
    """OKLab: lightness, then green-red and blue-yellow, where distances match how
    different colors look, blues included."""
    def linear(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (linear(c) for c in rgb)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def distance(a, b):
    """How different two OKLab colors look, with hue counting double so a color
    keeps its hue on the watch, such as the Avalanche's burgundy staying red."""
    ca, cb = math.hypot(a[1], a[2]), math.hypot(b[1], b[2])
    hue = max((a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 - (ca - cb) ** 2, 0)
    return (a[0] - b[0]) ** 2 + (ca - cb) ** 2 + 2 * hue


def nearest(rgb, colors):
    target = oklab(rgb)
    return min(colors, key=lambda c: distance(oklab(c), target))


# The watch's 64 colors: each channel 0x00, 0x55, 0xAA, or 0xFF.
WATCH_COLORS = [(r, g, b) for r in (0, 85, 170, 255) for g in (0, 85, 170, 255) for b in (0, 85, 170, 255)]
WATCH_GRAYS = [(v, v, v) for v in (0, 85, 170, 255)]
# Colors this close to gray take a watch gray, so near-blacks don't turn blue.
GRAY_CHROMA = 0.03


def watch_color(rgb, cache={}):
    """The watch color that looks closest. src/pkjs/colors.js converts team colors
    the same way, so the face and the logos match."""
    if rgb not in cache:
        L, a, b = oklab(rgb)
        cache[rgb] = nearest(rgb, WATCH_GRAYS if math.hypot(a, b) < GRAY_CHROMA else WATCH_COLORS)
    return cache[rgb]


def colorize(im):
    """The logo in its main colors as the watch shows them. Colors covering only a
    sliver of the logo are blends along edges, and take the nearest main color."""
    px = im.load()
    opaque = [(x, y) for y in range(im.size[1]) for x in range(im.size[0]) if px[x, y][3] >= 128]
    counts = Counter(watch_color(px[x, y][:3]) for x, y in opaque)
    main = [c for c, n in counts.most_common(15) if n >= len(opaque) * MIN_SHARE]
    out = Image.new('P', im.size, 0)
    # Entry 0 is transparent.
    out.putpalette([0, 0, 0] + [v for c in main for v in c])
    opx = out.load()
    for x, y in opaque:
        rgb = px[x, y][:3]
        opx[x, y] = main.index(nearest(rgb, main)) + 1
    out.info['transparency'] = 0
    return out


def media(name, file):
    return {
        'type': 'bitmap',
        'name': name,
        'file': file,
        'memoryFormat': 'Smallest',
        'storageFormat': 'png',
        'targetPlatforms': list(SIZES),
    }


def main():
    abbrs = teams()
    # Teams whose logo for dark backgrounds differs from the regular one.
    dark = set()
    for abbr in abbrs:
        svgs = {}
        for variant in ('light', 'dark'):
            with urllib.request.urlopen(URL.format(abbr, variant)) as r:
                svgs[variant] = r.read().decode()
        for platform, size in SIZES.items():
            path = 'resources/images/logo_{}~{}.png'.format(abbr, platform)
            quantize(render(svgs['light'], size)).save(path, transparency=0, optimize=True)
            light = colorize(render(svgs['light'], size))
            light.save('resources/images/logo_color_{}~{}.png'.format(abbr, platform), transparency=0, optimize=True)
            on_dark = colorize(render(svgs['dark'], size))
            if on_dark.tobytes() != light.tobytes() or on_dark.getpalette() != light.getpalette():
                dark.add(abbr)
                on_dark.save('resources/images/logo_color_dark_{}~{}.png'.format(abbr, platform),
                             transparency=0, optimize=True)
        print(abbr)

    with open('src/c/logos.h', 'w') as f:
        f.write('// Generated by tools/make_logos.py.\n#pragma once\n\n#ifdef PBL_COLOR\n')
        f.write('// The faded logo, the color one, and the color one for dark panels if it differs.\n')
        f.write('static const struct { const char *abbr; uint32_t faded, color, color_dark; } LOGOS[] = {\n')
        for abbr in abbrs:
            f.write('  {{ "{0}", RESOURCE_ID_LOGO_{0}, RESOURCE_ID_LOGO_COLOR_{0}, {1} }},\n'.format(
                abbr, 'RESOURCE_ID_LOGO_COLOR_DARK_' + abbr if abbr in dark else '0'))
        f.write('};\n#endif\n')

    with open('package.json') as f:
        pkg = json.load(f)
    # Keep the other resources, such as the menu icon.
    resources = [r for r in pkg['pebble']['resources']['media'] if not r['name'].startswith('LOGO_')]
    for abbr in abbrs:
        resources.append(dict(media('LOGO_' + abbr, 'images/logo_{}.png'.format(abbr)), memoryFormat='1BitPalette'))
        resources.append(media('LOGO_COLOR_' + abbr, 'images/logo_color_{}.png'.format(abbr)))
        if abbr in dark:
            resources.append(media('LOGO_COLOR_DARK_' + abbr, 'images/logo_color_dark_{}.png'.format(abbr)))
    pkg['pebble']['resources']['media'] = resources
    with open('package.json', 'w') as f:
        json.dump(pkg, f, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()
