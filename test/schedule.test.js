var test = require('node:test');
var assert = require('node:assert');
var s = require('../src/pkjs/schedule');
var f = require('./fixtures');
var game = f.game, NOW = f.NOW;

function pick(games) {
  var out = {};
  Object.keys(games).forEach(function(k) { out[k] = games[k] && games[k].id; });
  return out;
}

test('a game later today is the next game', function() {
  var later = game(2), after = game(26);
  var games = s.teamGames(f.schedule(later, after), NOW);
  assert.deepStrictEqual(pick(games), { live: null, suspended: null, recentFinal: null, delayed: null, next: later.id });
});

test('a game being played is the live game', function() {
  var live = game(-1, { gameState: 'LIVE' }), next = game(26);
  var games = s.teamGames(f.schedule(live, next), NOW);
  assert.strictEqual(games.live, live);
  assert.strictEqual(games.next, next);
});

test('a finished game is a recent final until 6 hours after puck drop', function() {
  var done = game(-3, { gameState: 'OFF' });
  assert.strictEqual(s.teamGames(f.schedule(done), NOW).recentFinal, done);
  var old = game(-6.1, { gameState: 'OFF' });
  assert.strictEqual(s.teamGames(f.schedule(old), NOW).recentFinal, null);
});

test('a game past its puck drop but not started is delayed, and the game after it is next', function() {
  var late = game(-0.2, { gameState: 'PRE' }), after = game(26);
  var games = s.teamGames(f.schedule(late, after), NOW);
  assert.strictEqual(games.delayed, late);
  assert.strictEqual(games.next, after);
  assert.strictEqual(s.nextOrDelayed(games), late);
});

test('a postponed game is skipped for the game after it', function() {
  var ppd = game(2, { gameScheduleState: 'PPD' }), after = game(26);
  var games = s.teamGames(f.schedule(ppd, after), NOW);
  assert.strictEqual(games.next, after);
  assert.strictEqual(games.delayed, null);
});

test('a cancelled game is never shown', function() {
  var cncl = game(-1, { gameState: 'OFF', gameScheduleState: 'CNCL' });
  assert.deepStrictEqual(pick(s.teamGames(f.schedule(cncl), NOW)),
                         { live: null, suspended: null, recentFinal: null, delayed: null, next: null });
});

test('a suspended game is the suspended game, not a final, until 6 hours after puck drop', function() {
  var susp = game(-2, { gameState: 'OFF', gameScheduleState: 'SUSP' });
  var games = s.teamGames(f.schedule(susp), NOW);
  assert.strictEqual(games.suspended, susp);
  assert.strictEqual(games.recentFinal, null);
  var old = game(-7, { gameState: 'OFF', gameScheduleState: 'SUSP' });
  assert.strictEqual(s.teamGames(f.schedule(old), NOW).suspended, null);
});

test('awayToday counts away games today, but not postponed or cancelled ones', function() {
  var away = game(1, { awayTeam: { abbrev: 'BOS' } });
  assert.strictEqual(s.awayToday('BOS', f.schedule(away), NOW), true);
  assert.strictEqual(s.awayToday('TOR', f.schedule(away), NOW), false);
  assert.strictEqual(s.awayToday('BOS', f.schedule(game(1, { gameScheduleState: 'PPD' })), NOW), false);
  assert.strictEqual(s.awayToday('BOS', f.schedule(game(1, { gameScheduleState: 'CNCL' })), NOW), false);
  assert.strictEqual(s.awayToday('BOS', f.schedule(game(30)), NOW), false);
});

test('getPlayoffSeasonId is the season once only playoff games are left', function() {
  var regular = game(-48, { gameState: 'OFF' });
  var playoff = game(24, { gameType: 3, season: 20252026 });
  assert.strictEqual(s.getPlayoffSeasonId(f.schedule(regular, playoff)), 20252026);
  assert.strictEqual(s.getPlayoffSeasonId(f.schedule(game(2), playoff)), null);
  assert.strictEqual(s.getPlayoffSeasonId(f.schedule(regular)), null);
  var cancelled = game(2, { gameScheduleState: 'CNCL' });
  assert.strictEqual(s.getPlayoffSeasonId(f.schedule(regular, cancelled, playoff)), 20252026);
});
