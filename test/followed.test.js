var test = require('node:test');
var assert = require('node:assert');
var chooseTeam = require('../src/pkjs/followed').chooseTeam;
var teamGames = require('../src/pkjs/schedule').teamGames;
var f = require('./fixtures');
var game = f.game, NOW = f.NOW;

function entry(team) {
  return { team: team, games: teamGames(f.schedule.apply(null, [].slice.call(arguments, 1)), NOW) };
}
function never() { return false; }

test('a live game beats a recent final', function() {
  var entries = [entry('BOS', game(-4, { gameState: 'OFF' })), entry('TOR', game(-1, { gameState: 'LIVE' }))];
  assert.strictEqual(chooseTeam(entries, never, null), 'TOR');
});

test('a delayed game counts as about to start', function() {
  var entries = [entry('BOS', game(-3, { gameState: 'OFF' })), entry('TOR', game(-0.1, { gameState: 'PRE' }))];
  assert.strictEqual(chooseTeam(entries, function(g) { return !!g; }, null), 'TOR');
});

test('a held suspended game stays shown', function() {
  var susp = game(-2, { gameState: 'OFF', gameScheduleState: 'SUSP' });
  var entries = [entry('BOS', game(-1, { gameState: 'LIVE' })), entry('TOR', susp)];
  assert.strictEqual(chooseTeam(entries, never, susp.id), 'TOR');
});

test('with nothing to show, team 1', function() {
  assert.strictEqual(chooseTeam([entry('BOS'), entry('TOR')], never, null), 'BOS');
});
