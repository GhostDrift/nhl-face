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

// Home colors normally; on the day of an away game, the away-jersey look: white where
// the main color goes, the main color where the second color goes, and a pinstripe
// that stands out from both.
function teamColors(info, away) {
  if (!away) {
    return { primary: info.primary, secondary: info.secondary, tertiary: info.tertiary };
  }
  var primary = 0xFFFFFF, secondary = info.awaySecondary || info.primary;
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

// Labels set into the pinstripes take the color the scheme asks for (a color, or
// 'text' for the regular text color), or else the stripe's color, unless that's too
// close in brightness to the tab behind them to read.
function labelColor(colors, label) {
  var text = textColorFor(colors.secondary);
  if (label === 'text') return text;
  if (label !== undefined) return label;
  return Math.abs(watchLuminance(colors.tertiary) - watchLuminance(colors.secondary)) >= 30 ? colors.tertiary : text;
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
  setColors(msg, teamColors(scheme, away), away ? scheme.awayLabel : scheme.homeLabel);
}

module.exports = { applyScheme: applyScheme };
