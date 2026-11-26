var test = require('node:test');
var assert = require('node:assert');
var keys = require('message_keys');
var faceMessage = require('../src/pkjs/face-message').faceMessage;
var gameMessage = require('../src/pkjs/face-message').gameMessage;
var teamGames = require('../src/pkjs/schedule').teamGames;
var settings = require('../src/pkjs/settings');
var f = require('./fixtures');
var game = f.game, NOW = f.NOW;

var SETTINGS = settings.read(f.fakeLocalStorage({ team: 'BOS' }));

function standings(rows) {
  return { standings: rows || [{ teamAbbrev: { default: 'BOS' }, wins: 12, losses: 5, otLosses: 2, points: 26,
                                 divisionName: 'Atlantic', divisionSequence: 1, leagueSequence: 3, clinchIndicator: null }] };
}

function message(over) {
  var input = { team: 'BOS', games: teamGames(f.schedule(game(26)), NOW), scoreboard: null, standings: standings(),
                bracket: null, settings: SETTINGS, platform: 'basalt', others: [], awayToday: false, now: NOW };
  for (var k in over || {}) input[k] = over[k];
  return faceMessage(input);
}

function scoreboard(opts) {
  var b = { id: 1, gameState: 'LIVE', awayTeam: { abbrev: 'BOS', score: 2, sog: 20 }, homeTeam: { abbrev: 'TOR', score: 1, sog: 15 },
            periodDescriptor: { number: 2, periodType: 'REG' }, clock: { timeRemaining: '12:34', inIntermission: false } };
  for (var k in opts || {}) b[k] = opts[k];
  return b;
}

test('the team, its colors and its stats', function() {
  var msg = message();
  assert.strictEqual(msg[keys.TeamName], 'BRUINS');
  assert.strictEqual(msg[keys.TeamAbbrev], 'BOS');
  assert.strictEqual(typeof msg[keys.ColorPrimary], 'number');
  assert.strictEqual(msg[keys.Record], '12-5-2');
  assert.strictEqual(msg[keys.Points], '26');
  assert.strictEqual(msg[keys.DivName], 'ATL');
  assert.strictEqual(msg[keys.DivRank], '1st');
  assert.strictEqual(msg[keys.LeagueRank], '3rd');
});

test('without a schedule, the game is left as it is', function() {
  var msg = message({ games: null });
  assert.strictEqual(msg[keys.GameState], undefined);
  assert.strictEqual(msg[keys.RefreshMins], 10);
});

test('the next game, its opponent and where', function() {
  var next = game(26, { awayTeam: { abbrev: 'BOS' }, homeTeam: { abbrev: 'TOR' } });
  var msg = message({ games: teamGames(f.schedule(next), NOW) });
  assert.strictEqual(msg[keys.GameState], 1);
  assert.strictEqual(msg[keys.GameStart], Math.floor(Date.parse(next.startTimeUTC) / 1000));
  assert.strictEqual(msg[keys.GameOpp], 'TOR');
  assert.strictEqual(msg[keys.GameHome], 0);
  assert.strictEqual(msg[keys.RefreshMins], 30);
});

test('a game within the hour refreshes every 5 minutes, and so does one of another team', function() {
  assert.strictEqual(message({ games: teamGames(f.schedule(game(0.5)), NOW) })[keys.RefreshMins], 5);
  var others = [{ team: 'TOR', games: teamGames(f.schedule(game(0.5)), NOW) }];
  assert.strictEqual(message({ others: others })[keys.RefreshMins], 5);
});

test('a live game with the clock and shots, from the scoreboard', function() {
  var live = game(-1, { gameState: 'LIVE', id: 1 });
  var msg = message({ games: teamGames(f.schedule(live), NOW), scoreboard: scoreboard() });
  assert.strictEqual(msg[keys.GameState], 2);
  assert.strictEqual(msg[keys.GameLine1], 'LIVE  2nd 12:34');
  assert.strictEqual(msg[keys.GameLine2], 'BOS 2  @  TOR 1');
  assert.strictEqual(msg[keys.GameAwayShots], '20');
  assert.strictEqual(msg[keys.RefreshMins], 1);
});

test('shots stay off when turned off, and intermission refreshes less often', function() {
  var live = game(-1, { gameState: 'LIVE', id: 1 });
  var noShots = settings.read(f.fakeLocalStorage({ showShots: '0' }));
  var msg = message({ games: teamGames(f.schedule(live), NOW), settings: noShots,
                      scoreboard: scoreboard({ clock: { timeRemaining: '18:00', inIntermission: true } }) });
  assert.strictEqual(msg[keys.GameAwayShots], undefined);
  assert.strictEqual(msg[keys.GameLine1], 'LIVE  2nd INT');
  assert.strictEqual(msg[keys.RefreshMins], 5);
});

test('the scoreboard shows a game live before the schedule does', function() {
  var soon = game(-0.05, { gameState: 'PRE', id: 1 });
  var msg = message({ games: teamGames(f.schedule(soon), NOW), scoreboard: scoreboard() });
  assert.strictEqual(msg[keys.GameState], 2);
});

test('a final, with overtime', function() {
  var done = game(-3, { gameState: 'OFF', gameOutcome: { lastPeriodType: 'OT' },
                        awayTeam: { abbrev: 'BOS', score: 3 }, homeTeam: { abbrev: 'TOR', score: 2 } });
  var msg = message({ games: teamGames(f.schedule(done), NOW) });
  assert.strictEqual(msg[keys.GameState], 3);
  assert.strictEqual(msg[keys.GameLine1], 'FINAL/OT');
  assert.strictEqual(msg[keys.GameLine2], 'BOS 3  @  TOR 2');
});

test('a suspended game shows SUSPENDED with its score', function() {
  var susp = game(-2, { gameState: 'OFF', gameScheduleState: 'SUSP',
                        awayTeam: { abbrev: 'BOS', score: 1 }, homeTeam: { abbrev: 'TOR', score: 1 } });
  var msg = message({ games: teamGames(f.schedule(susp), NOW) });
  assert.strictEqual(msg[keys.GameState], 3);
  assert.strictEqual(msg[keys.GameLine1], 'SUSPENDED');
  assert.strictEqual(msg[keys.GameLine2], 'BOS 1  @  TOR 1');
});

test('with no game to show, where the season stands', function() {
  var out = standings([{ teamAbbrev: { default: 'BOS' }, wins: 30, losses: 40, otLosses: 5, points: 65,
                         divisionName: 'Atlantic', divisionSequence: 8, leagueSequence: 30, clinchIndicator: 'e' }]);
  var msg = message({ games: teamGames(f.schedule(), NOW), standings: out });
  assert.strictEqual(msg[keys.GameLine1], 'PLAYOFFS');
  assert.strictEqual(msg[keys.GameLine2], 'ELIMINATED');
});

test('playoff labels are longer on the Pebble Time 2', function() {
  function series(round) {
    return { roundNumber: round, neededToWin: 4, topSeed: { abbrev: 'BOS', wins: round < 3 ? 4 : 2 }, bottomSeed: { abbrev: 'X' + round, wins: 1 } };
  }
  var bracket = { rounds: [1, 2, 3].map(function(r) { return { series: [series(r)] }; }) };
  var big = message({ bracket: bracket, platform: 'emery' });
  var small = message({ bracket: bracket, platform: 'basalt' });
  assert.strictEqual(big[keys.RecordLabel], 'CONF FINAL');
  assert.strictEqual(small[keys.RecordLabel], 'ROUND 3');
  assert.strictEqual(big[keys.Record], 'LEAD 2-1');
  assert.strictEqual(big[keys.DivRank], '10-3');
  assert.strictEqual(big[keys.LeagueRank], '6');
});

test('away colors on an away day, if turned on', function() {
  var home = message();
  var away = message({ awayToday: true });
  assert.notStrictEqual(away[keys.ColorPrimary], home[keys.ColorPrimary]);
  var off = settings.read(f.fakeLocalStorage({ awayColors: '0' }));
  assert.strictEqual(message({ awayToday: true, settings: off })[keys.ColorPrimary], home[keys.ColorPrimary]);
});

test('gameMessage has just the game and its refresh', function() {
  var live = game(-1, { gameState: 'LIVE', id: 1 });
  var msg = gameMessage('BOS', teamGames(f.schedule(live), NOW), scoreboard(), SETTINGS, NOW);
  assert.strictEqual(msg[keys.GameState], 2);
  assert.strictEqual(msg[keys.TeamName], undefined);
  assert.strictEqual(msg[keys.RefreshMins], 1);
});
