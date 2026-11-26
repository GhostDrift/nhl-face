// Builders for NHL feed data, with just the fields the modules read.

var H = 60 * 60 * 1000;
// A fixed time, a Tuesday evening in Los Angeles, so tests don't depend on the clock.
var NOW = Date.parse('2026-11-24T19:00:00-08:00');

var nextId = 2025020001;

// A schedule game starting hours from NOW. opts overrides any field.
function game(hours, opts) {
  var g = {
    id: nextId++,
    season: 20252026,
    gameType: 2,
    gameDate: '2026-11-24',
    startTimeUTC: new Date(NOW + hours * H).toISOString(),
    gameState: 'FUT',
    gameScheduleState: 'OK',
    awayTeam: { abbrev: 'BOS', score: 0 },
    homeTeam: { abbrev: 'TOR', score: 0 }
  };
  for (var k in opts || {}) g[k] = opts[k];
  return g;
}

function schedule() {
  return { games: Array.prototype.slice.call(arguments) };
}

// A stand-in for the phone's localStorage, starting with values.
function fakeLocalStorage(values) {
  var data = {};
  for (var k in values || {}) data[k] = String(values[k]);
  return {
    data: data,
    getItem: function(key) { return key in data ? data[key] : null; },
    setItem: function(key, value) { data[key] = String(value); },
    removeItem: function(key) { delete data[key]; }
  };
}

module.exports = { H: H, NOW: NOW, game: game, schedule: schedule, fakeLocalStorage: fakeLocalStorage };
