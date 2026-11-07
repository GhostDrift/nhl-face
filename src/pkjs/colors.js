var keys = require('message_keys');

// Black or white text, whichever reads better on the given background.
function textColorFor(rgb) {
  var r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? 0x000000 : 0xFFFFFF;
}

function colorDistance(a, b) {
  var dr = ((a >> 16) & 0xFF) - ((b >> 16) & 0xFF);
  var dg = ((a >> 8) & 0xFF) - ((b >> 8) & 0xFF);
  var db = (a & 0xFF) - (b & 0xFF);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// OKLab: lightness, then green-red and blue-yellow, where distances match how
// different colors look.
function oklab(rgb) {
  function linear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  var r = linear((rgb >> 16) & 0xFF), g = linear((rgb >> 8) & 0xFF), b = linear(rgb & 0xFF);
  var l = Math.pow(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 1 / 3);
  var m = Math.pow(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 1 / 3);
  var s = Math.pow(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 1 / 3);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

// How different two OKLab colors look, with hue counting double so a color keeps its
// hue on the watch.
function lookDistance(a, b) {
  var ca = Math.sqrt(a[1] * a[1] + a[2] * a[2]), cb = Math.sqrt(b[1] * b[1] + b[2] * b[2]);
  var hue = Math.max((a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]) - (ca - cb) * (ca - cb), 0);
  return (a[0] - b[0]) * (a[0] - b[0]) + (ca - cb) * (ca - cb) + 2 * hue;
}

var LEVELS = [0x00, 0x55, 0xAA, 0xFF];
// Colors this close to gray take a watch gray, so near-blacks don't turn blue.
var GRAY_CHROMA = 0.03;

// The closest looking of the watch's 64 colors. The watch would otherwise cut each
// channel to its top two bits, which can shift a color's hue.
function watchColor(rgb) {
  var target = oklab(rgb);
  var gray = Math.sqrt(target[1] * target[1] + target[2] * target[2]) < GRAY_CHROMA;
  var best = 0, bestDist = Infinity;
  LEVELS.forEach(function(r) {
    LEVELS.forEach(function(g) {
      LEVELS.forEach(function(b) {
        if (gray && (r !== g || g !== b)) return;
        var c = (r << 16) | (g << 8) | b;
        var d = lookDistance(oklab(c), target);
        if (d < bestDist) {
          best = c;
          bestDist = d;
        }
      });
    });
  });
  return best;
}

// Home colors normally; on the day of an away game, the away-jersey look: white where
// the main color goes, the main color where the second color goes, and a pinstripe
// that stands out from both, unless the scheme names one.
function teamColors(info, away) {
  if (!away) {
    return { primary: info.primary, secondary: info.secondary, tertiary: info.tertiary };
  }
  var primary = 0xFFFFFF, secondary = info.awaySecondary || info.primary;
  if (info.awayTertiary !== undefined) {
    return { primary: primary, secondary: secondary, tertiary: info.awayTertiary };
  }
  var tertiary = 0x000000;
  var candidates = [info.secondary, info.tertiary];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (colorDistance(c, primary) > 100 && colorDistance(c, secondary) > 100) {
      tertiary = c;
      break;
    }
  }
  return { primary: primary, secondary: secondary, tertiary: tertiary };
}

// Brightness from 0 to 255 of a color as the watch shows it: each channel cut to
// its top two bits.
function watchLuminance(rgb) {
  var r = ((rgb >> 16) & 0xFF) >> 6, g = ((rgb >> 8) & 0xFF) >> 6, b = (rgb & 0xFF) >> 6;
  return (0.299 * r + 0.587 * g + 0.114 * b) * 85;
}

// How much lighter the lighter of two colors looks, from 1 (no difference) to 21
// (black and white): the WCAG contrast ratio.
function contrast(a, b) {
  function luminance(rgb) {
    return [0.2126, 0.7152, 0.0722].reduce(function(sum, w, i) {
      var c = ((rgb >> (16 - 8 * i)) & 0xFF) / 255;
      return sum + w * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    }, 0);
  }
  var la = luminance(a) + 0.05, lb = luminance(b) + 0.05;
  return Math.max(la, lb) / Math.min(la, lb);
}

// Labels set into the pinstripes take the color the scheme asks for (a color, or
// 'text' for the regular text color), or else the stripe's color, unless that's too
// close in brightness to the tab behind them to read, or too low in contrast, like
// red on dark gray.
function labelColor(colors, label) {
  var text = textColorFor(colors.secondary);
  if (label === 'text') return text;
  if (label !== undefined) return label;
  var readable = Math.abs(watchLuminance(colors.tertiary) - watchLuminance(colors.secondary)) >= 30 &&
                 contrast(colors.tertiary, colors.secondary) >= 1.2;
  return readable ? colors.tertiary : text;
}

function setColors(msg, colors, label) {
  msg[keys.ColorPrimary] = colors.primary;
  msg[keys.ColorSecondary] = colors.secondary;
  msg[keys.ColorTertiary] = colors.tertiary;
  msg[keys.ColorText] = textColorFor(colors.primary);
  msg[keys.ColorText2] = textColorFor(colors.secondary);
  msg[keys.ColorLabel] = labelColor(colors, label);
}

// Adds a team color scheme's home or away colors to msg.
function applyScheme(msg, scheme, away) {
  var colors = teamColors(scheme, away);
  for (var k in colors) colors[k] = watchColor(colors[k]);
  var label = away ? scheme.awayLabel : scheme.homeLabel;
  setColors(msg, colors, typeof label === 'number' ? watchColor(label) : label);
}

module.exports = { applyScheme: applyScheme, watchColor: watchColor };
