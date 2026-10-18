// NHL team colors: primary (background, block panels), secondary (block borders, bubbles),
// tertiary (pinstripes). Tertiary sits between the other two, so it differs from both.
// The watch maps these to the nearest of its 64 colors; a few are picked straight
// from that palette because the official color maps to the wrong hue or shade
// (SJS, NYI, NYR, CGY, COL, DAL, MTL, STL, TBL, VGK, WPG).
//
// Classic schemes are older team colors to pick from in settings. Most are picked
// straight from the watch's palette, since faded jersey colors map to murky ones.
// awaySecondary, if set, replaces the main color on away days, for schemes whose
// main color is black. homeLabel and awayLabel, if set, color the labels set into
// the pinstripes instead of the stripe color: a color, or 'text' for the regular
// text color.
module.exports = {
  ANA: { name: 'Ducks',          primary: 0xF47A38, secondary: 0x000000, tertiary: 0xA2AAAD,
         classics: [
           { id: 'mighty', name: 'Mighty Ducks (1993–2006)', primary: 0x5500AA, secondary: 0x00AAAA, tertiary: 0xAAAAAA, homeLabel: 'text', awayLabel: 'text' }
         ] },
  BOS: { name: 'Bruins',         primary: 0xFFB81C, secondary: 0x000000, tertiary: 0xFFFFFF },
  BUF: { name: 'Sabres',         primary: 0x003087, secondary: 0xFFB81C, tertiary: 0xFFFFFF,
         classics: [
           { id: 'goat', name: 'Goat head (1996–2006)', primary: 0x000000, secondary: 0xCE1126, tertiary: 0xAAAAAA, awaySecondary: 0xCE1126 }
         ] },
  CAR: { name: 'Hurricanes',     primary: 0xCE1126, secondary: 0x000000, tertiary: 0xA4A9AD,
         classics: [
           { id: 'whalers', name: 'Hartford Whalers (1979–97)', primary: 0x00AA00, secondary: 0x0000AA, tertiary: 0xFFFFFF }
         ] },
  CBJ: { name: 'Blue Jackets',   primary: 0x002654, secondary: 0xCE1126, tertiary: 0xFFFFFF },
  CGY: { name: 'Flames',         primary: 0xC8102E, secondary: 0xFFFF00, tertiary: 0x111111 },
  CHI: { name: 'Blackhawks',     primary: 0xCF0A2C, secondary: 0x000000, tertiary: 0xFFFFFF },
  COL: { name: 'Avalanche',      primary: 0x6F263D, secondary: 0x0000AA, tertiary: 0xA2AAAD },
  DAL: { name: 'Stars',          primary: 0x006847, secondary: 0x555555, tertiary: 0x111111,
         classics: [
           { id: 'black', name: 'Black and green (1993–2013)', primary: 0x000000, secondary: 0x00AA55, tertiary: 0xAAAA55, awaySecondary: 0x00AA55 }
         ] },
  DET: { name: 'Red Wings',      primary: 0xCE1126, secondary: 0xFFFFFF, tertiary: 0x000000 },
  EDM: { name: 'Oilers',         primary: 0x041E42, secondary: 0xFF4C00, tertiary: 0xFFFFFF,
         classics: [
           { id: 'copper', name: 'Navy and copper (2001–11)', primary: 0x000055, secondary: 0xAA5500, tertiary: 0xAAAAAA, homeLabel: 'text' }
         ] },
  FLA: { name: 'Panthers',       primary: 0x041E42, secondary: 0xC8102E, tertiary: 0xB9975B },
  LAK: { name: 'Kings',          primary: 0x111111, secondary: 0xA2AAAD, tertiary: 0xFFFFFF, homeLabel: 'text',
         classics: [
           { id: '1998', name: 'Black and purple (1998–2011)', primary: 0x000000, secondary: 0x702F8A, tertiary: 0xA2AAAD, awaySecondary: 0x702F8A },
           { id: '1967', name: 'Purple and gold (1967–88)', primary: 0x5500AA, secondary: 0xFFAA00, tertiary: 0xFFFFFF }
         ] },
  MIN: { name: 'Wild',           primary: 0x154734, secondary: 0xA6192E, tertiary: 0xEAAA00 },
  MTL: { name: 'Canadiens',      primary: 0xAF1E2D, secondary: 0x0000AA, tertiary: 0xFFFFFF },
  NJD: { name: 'Devils',         primary: 0xCE1126, secondary: 0x000000, tertiary: 0xFFFFFF,
         classics: [
           { id: 'green', name: 'Red and green (1982–92)', primary: 0xCE1126, secondary: 0x005500, tertiary: 0xFFFFFF }
         ] },
  NSH: { name: 'Predators',      primary: 0xFFB81C, secondary: 0x041E42, tertiary: 0xFFFFFF },
  NYI: { name: 'Islanders',      primary: 0x0000FF, secondary: 0xF47D30, tertiary: 0xFFFFFF,
         classics: [
           { id: 'fisherman', name: 'Fisherman (1995–97)', primary: 0x0055AA, secondary: 0xFF5500, tertiary: 0x000055 }
         ] },
  NYR: { name: 'Rangers',        primary: 0x0000FF, secondary: 0xCE1126, tertiary: 0xFFFFFF },
  OTT: { name: 'Senators',       primary: 0xC52032, secondary: 0xC2912C, tertiary: 0x000000 },
  PHI: { name: 'Flyers',         primary: 0xF74902, secondary: 0x000000, tertiary: 0xFFFFFF },
  PIT: { name: 'Penguins',       primary: 0x000000, secondary: 0xFCB514, tertiary: 0xFFFFFF,
         classics: [
           { id: 'powder', name: 'Powder blue (1967–80)', primary: 0x55AAFF, secondary: 0x000055, tertiary: 0xFFFFFF }
         ] },
  SEA: { name: 'Kraken',         primary: 0x001628, secondary: 0x99D9D9, tertiary: 0xE9072B },
  SJS: { name: 'Sharks',         primary: 0x0055AA, secondary: 0x000000, tertiary: 0xEA7200 },
  STL: { name: 'Blues',          primary: 0x002F87, secondary: 0xFFFF00, tertiary: 0xFFFFFF, homeLabel: 0x002F87 },
  TBL: { name: 'Lightning',      primary: 0x0000AA, secondary: 0xFFFFFF, tertiary: 0x000000,
         classics: [
           { id: 'black', name: 'Black and blue (1992–2007)', primary: 0x000000, secondary: 0x0055AA, tertiary: 0xAAAAAA, awaySecondary: 0x0055AA }
         ] },
  TOR: { name: 'Maple Leafs',    primary: 0x00205B, secondary: 0xFFFFFF, tertiary: 0x000000 },
  UTA: { name: 'Mammoth',        primary: 0x6CACE4, secondary: 0x010101, tertiary: 0xFFFFFF },
  VAN: { name: 'Canucks',        primary: 0x00205B, secondary: 0x00843D, tertiary: 0xFFFFFF,
         classics: [
           { id: 'skate', name: 'Flying skate (1978–97)', primary: 0x000000, secondary: 0xC8102E, tertiary: 0xFFAA00, awaySecondary: 0xC8102E }
         ] },
  VGK: { name: 'Golden Knights', primary: 0xB4975A, secondary: 0x555555, tertiary: 0xC8102E },
  WPG: { name: 'Jets',           primary: 0x000055, secondary: 0xFFFFFF, tertiary: 0xAA0000,
         classics: [
           { id: 'original', name: 'Original Jets (1979–96)', primary: 0x0055AA, secondary: 0xC8102E, tertiary: 0xFFFFFF }
         ] },
  WSH: { name: 'Capitals',       primary: 0xC8102E, secondary: 0x041E42, tertiary: 0xFFFFFF,
         classics: [
           { id: 'eagle', name: 'Screaming Eagle (1995–2007)', primary: 0x000055, secondary: 0xAAAA55, tertiary: 0x000000 }
         ] }
};
