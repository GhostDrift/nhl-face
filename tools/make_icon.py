"""Draws the app's menu icon, resources/images/menu_icon.png: a miniature of the face,
shown for the app on the watch and in the phone app.

Run from the project root:
  uv run --no-project --with pillow python tools/make_icon.py
"""
from PIL import Image, ImageDraw

# A miniature of the face: the watch block on top, the NHL block below with three
# rows of bubbles, in the Pebble palette's navy, white, and red.
N, PANEL, BORDER, STRIPE, BUBBLE = (0, 0, 0), (0, 0, 85), (255, 255, 255), (170, 0, 0), (255, 255, 255)
im = Image.new('RGB', (25, 25), N)
d = ImageDraw.Draw(im)
def block(x0, y0, x1, y1):
    d.rectangle([x0, y0, x1, y1], fill=BORDER)
    d.rectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1], outline=STRIPE)
    d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=PANEL)
block(0, 0, 24, 8)
# The time: four digits and a colon.
for x in (5, 8, 14, 17):
    d.rectangle([x, 3, x + 1, 5], fill=BORDER)
d.point([(11, 3), (11, 5)], fill=BORDER)
block(0, 10, 24, 24)
d.rectangle([4, 13, 20, 14], fill=BUBBLE)
d.rectangle([4, 16, 13, 17], fill=BUBBLE); d.rectangle([15, 16, 20, 17], fill=BUBBLE)
d.rectangle([4, 19, 11, 20], fill=BUBBLE); d.rectangle([13, 19, 20, 20], fill=BUBBLE)
im.save('resources/images/menu_icon.png')
