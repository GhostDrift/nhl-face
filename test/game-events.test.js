var test = require('node:test');
var assert = require('node:assert');
var events = require('../src/pkjs/game-events');
var f = require('./fixtures');
var NOW = f.NOW;

var SETTINGS = { goalVibe: 'both', goalBanner: true, bannerSecs: 30, vibeOnPeriod: true, vibeOnFinal: true };

function settings(over) {
  var s = {};
  for (var k in SETTINGS) s[k] = SETTINGS[k];
  for (k in over || {}) s[k] = over[k];
  return s;
}

// A scoreboard entry for BOS @ TOR: period, scores, intermission, and goals listed.
function board(period, away, home, opts) {
  opts = opts || {};
  return {
    id: 7, gameDate: '2026-11-24', gameState: opts.state || 'LIVE',
    awayTeam: { abbrev: 'BOS', score: away }, homeTeam: { abbrev: 'TOR', score: home },
    periodDescriptor: { number: period, periodType: period > 3 ? 'OT' : 'REG' },
    clock: { inIntermission: !!opts.intermission },
    goals: opts.goals || []
  };
}

function live(b) {
  return { live: b, suspended: null, recentFinal: null, delayed: null, next: null };
}

function final(b) {
  return { live: null, suspended: null, recentFinal: b, delayed: null, next: null };
}

function goal(away, home, extra) {
  var g = { teamAbbrev: { default: 'BOS' }, awayScore: away, homeScore: home, name: { default: 'D. Pastrnak' },
            assists: [{ name: { default: 'B. Marchand' } }], periodDescriptor: { number: 2, periodType: 'REG' },
            timeInPeriod: '05:12', strength: 'ev' };
  for (var k in extra || {}) g[k] = extra[k];
  return g;
}

// Runs check over each scoreboard snapshot in turn, as BOS, returning each result.
function run(snapshots, s, games) {
  var seen = null;
  return snapshots.map(function(b) {
    var r = events.check(seen, 'BOS', (games || live)(b), b, s || SETTINGS, NOW);
    seen = r.lastSeen;
    return r;
  });
}

test('the first look at a game buzzes for nothing', function() {
  var r = run([board(2, 3, 1)])[0];
  assert.strictEqual(r.goal, null);
  assert.strictEqual(r.stage, null);
  assert.strictEqual(r.changed, false);
});

test('a goal for my team buzzes, and its banner shows once listed', function() {
  var r = run([board(2, 0, 0), board(2, 1, 0, { goals: [goal(1, 0)] })])[1];
  assert.strictEqual(r.goal, 'mine');
  assert.deepStrictEqual(r.banner, { scorer: 'D. Pastrnak', assists: 'B. Marchand', time: '2nd 05:12',
                                     score: 'BOS 1  @  TOR 0', secs: 30 });
  assert.strictEqual(r.bannerWaiting, null);
  assert.strictEqual(r.changed, true);
});

test('goal tags: power play, short handed, empty net', function() {
  var r = run([board(3, 0, 0), board(3, 1, 0, { goals: [goal(1, 0, { strength: 'pp', goalModifier: 'awarded-empty-net', assists: [] })] })])[1];
  assert.strictEqual(r.banner.time, '2nd 05:12 PP EN');
  assert.strictEqual(r.banner.assists, 'Unassisted');
});

test('a goal not listed yet waits, and bannerFor sends it once it is', function() {
  var r = run([board(2, 0, 0), board(2, 1, 0)])[1];
  assert.strictEqual(r.banner, null);
  assert.strictEqual(r.bannerWaiting, 1);
  var later = events.bannerFor(r.lastSeen, 'BOS', 7, board(2, 1, 0), 1, SETTINGS, NOW);
  assert.strictEqual(later.banner, null);
  assert.strictEqual(later.outdated, false);
  later = events.bannerFor(r.lastSeen, 'BOS', 7, board(2, 1, 0, { goals: [goal(1, 0)] }), 1, SETTINGS, NOW);
  assert.strictEqual(later.banner.scorer, 'D. Pastrnak');
  assert.deepStrictEqual(later.lastSeen.banner, { id: 7, score: 'BOS 1  @  TOR 0', until: NOW + 30000 });
});

test('a waiting banner is outdated once my team scores again', function() {
  var rs = run([board(2, 0, 0), board(2, 1, 0), board(2, 2, 0)]);
  var later = events.bannerFor(rs[2].lastSeen, 'BOS', 7, board(2, 2, 0, { goals: [goal(1, 0)] }), 1, SETTINGS, NOW);
  assert.strictEqual(later.outdated, true);
  assert.strictEqual(later.banner, null);
});

test('the banner score updates when the other team scores while it shows', function() {
  var rs = run([board(2, 0, 0), board(2, 1, 0, { goals: [goal(1, 0)] }), board(2, 1, 1)]);
  assert.strictEqual(rs[2].goal, 'opp');
  assert.deepStrictEqual(rs[2].banner, { score: 'BOS 1  @  TOR 1' });
});

test('goal buzzes follow the goal vibe setting', function() {
  var snaps = [board(2, 0, 0), board(2, 0, 1), board(2, 1, 1, { goals: [goal(1, 1)] })];
  var mine = run(snaps, settings({ goalVibe: 'mine' }));
  assert.strictEqual(mine[1].goal, null);
  assert.strictEqual(mine[1].changed, true);
  assert.strictEqual(mine[2].goal, 'mine');
  var off = run(snaps, settings({ goalVibe: 'off', goalBanner: false }));
  assert.strictEqual(off[2].goal, null);
  assert.strictEqual(off[2].banner, null);
  assert.strictEqual(off[2].changed, true);
});

test('periods starting and ending buzz, if turned on', function() {
  var snaps = [board(1, 0, 0), board(1, 0, 0, { intermission: true }), board(2, 0, 0)];
  var on = run(snaps);
  assert.deepStrictEqual(on.map(function(r) { return r.stage; }), [null, 'period', 'period']);
  var off = run(snaps, settings({ vibeOnPeriod: false }));
  assert.deepStrictEqual(off.map(function(r) { return r.stage; }), [null, null, null]);
  assert.strictEqual(off[1].changed, true);
});

test('the final horn buzzes only for a game seen being played', function() {
  var seen = run([board(3, 2, 1)])[0].lastSeen;
  var r = events.check(seen, 'BOS', final(board(3, 2, 1, { state: 'OFF' })), null, SETTINGS, NOW);
  assert.strictEqual(r.stage, 'final');
  r = events.check(null, 'BOS', final(board(3, 2, 1, { state: 'OFF' })), null, SETTINGS, NOW);
  assert.strictEqual(r.stage, null);
});

test('a suspended game never counts as ending', function() {
  var seen = run([board(2, 1, 1)])[0].lastSeen;
  var b = board(2, 1, 1, { state: 'OFF' });
  var r = events.check(seen, 'BOS', { live: null, suspended: b, recentFinal: null, delayed: null, next: null }, null, SETTINGS, NOW);
  assert.strictEqual(r.stage, null);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.lastSeen.stage, seen.stage);
});

test('periodLabel names overtimes and the shootout', function() {
  assert.strictEqual(events.periodLabel({ number: 1, periodType: 'REG' }), '1st');
  assert.strictEqual(events.periodLabel({ number: 4, periodType: 'OT' }), 'OT');
  assert.strictEqual(events.periodLabel({ number: 6, periodType: 'OT' }), '3OT');
  assert.strictEqual(events.periodLabel({ number: 5, periodType: 'SO' }), 'SO');
});
