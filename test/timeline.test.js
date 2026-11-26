var test = require('node:test');
var assert = require('node:assert');
var createPins = require('../src/pkjs/timeline').createPins;
var f = require('./fixtures');
var NOW = f.NOW, H = f.H;

// A stand-in timeline: keeps pins by id and logs each call. failNext makes the next
// calls fail, as if the phone were offline.
function fakeTimeline() {
  var t = { pins: {}, log: [], failNext: 0 };
  function fail(callback) {
    if (!t.failNext) return false;
    t.failNext--;
    callback(new Error('offline'));
    return true;
  }
  t.put = function(pin, callback) {
    if (fail(callback)) return;
    t.log.push('put ' + pin.id);
    t.pins[pin.id] = pin;
    callback(null);
  };
  t.remove = function(id, callback) {
    if (fail(callback)) return;
    t.log.push('remove ' + id);
    delete t.pins[id];
    callback(null);
  };
  return t;
}

function setup() {
  var timeline = fakeTimeline(), ls = f.fakeLocalStorage();
  var pins = createPins({ timeline: timeline, localStorage: ls });
  return {
    timeline: timeline,
    localStorage: ls,
    // Syncs, returning what was sent this time.
    sync: function(schedules, records, on, now) {
      timeline.log = [];
      pins.sync(schedules, records || {}, on !== false, now || NOW);
      return timeline.log;
    },
    ids: function() { return Object.keys(timeline.pins).sort(); }
  };
}

function game(id, hours, opts) {
  var g = f.game(hours, opts);
  g.id = id;
  return g;
}

function at(g, hours) {
  g.startTimeUTC = new Date(NOW + hours * H).toISOString();
}

test('two teams with games at the same time each get a pin', function() {
  var p = setup();
  var bos = f.schedule(game(1, 2), game(2, 26));
  var mtl = f.schedule(game(9, 2, { awayTeam: { abbrev: 'MTL' }, homeTeam: { abbrev: 'NYR' } }));
  assert.deepStrictEqual(p.sync({ BOS: bos, MTL: mtl }), ['put nhl-game-1', 'put nhl-game-9']);
  assert.deepStrictEqual(p.sync({ BOS: bos, MTL: mtl }), [], 'nothing changed, nothing sent');
});

test('a game two followed teams share is pinned once', function() {
  var p = setup();
  var shared = game(1, 2, { awayTeam: { abbrev: 'BOS' }, homeTeam: { abbrev: 'TOR' } });
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(shared), TOR: f.schedule(shared) }), ['put nhl-game-1']);
});

test('a pin is sent again when a record changes', function() {
  var p = setup();
  var bos = f.schedule(game(1, 2));
  p.sync({ BOS: bos });
  assert.deepStrictEqual(p.sync({ BOS: bos }, { BOS: '10-2-1' }), ['put nhl-game-1']);
  assert.strictEqual(p.timeline.pins['nhl-game-1'].layout.recordAway, '10-2-1');
});

test('a delayed game keeps its pin, and the following game is pinned too', function() {
  var p = setup();
  var first = game(1, 0.1), second = game(2, 26);
  p.sync({ BOS: f.schedule(first, second) });
  first.gameState = 'PRE';
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(first, second) }, {}, true, NOW + 0.5 * H), ['put nhl-game-2']);
  assert.deepStrictEqual(p.ids(), ['nhl-game-1', 'nhl-game-2']);
});

test('the final pin replaces the upcoming pin, only once the final is in', function() {
  var p = setup();
  var g = game(1, -1, { gameState: 'LIVE' });
  p.localStorage.setItem('pinnedUpcoming', JSON.stringify({ 1: { start: g.startTimeUTC, sent: 'x', off: false } }));
  p.timeline.pins['nhl-game-1'] = {};
  g.gameState = 'OFF';
  p.timeline.failNext = 1;
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(g) }), [], 'final fails: upcoming stays');
  assert.deepStrictEqual(p.ids(), ['nhl-game-1']);
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(g) }), ['put nhl-final-1', 'remove nhl-game-1']);
  assert.deepStrictEqual(p.ids(), ['nhl-final-1']);
});

test('a failed removal of the upcoming pin is retried on the next sync', function() {
  var p = setup();
  var g = game(1, -3, { gameState: 'OFF' });
  p.localStorage.setItem('pinnedUpcoming', JSON.stringify({ 1: { start: g.startTimeUTC, sent: 'x', off: false } }));
  var failed = false;
  p.timeline.remove = (function(remove) {
    return function(id, cb) { if (!failed) { failed = true; cb(new Error('offline')); } else remove(id, cb); };
  })(p.timeline.remove);
  p.timeline.pins['nhl-game-1'] = {};
  p.sync({ BOS: f.schedule(g) });
  // The fake answers at once, so the retry comes in the same sync; on the phone, the next.
  assert.strictEqual(failed, true);
  assert.deepStrictEqual(p.ids(), ['nhl-final-1']);
  assert.deepStrictEqual(JSON.parse(p.localStorage.getItem('pinnedUpcoming')), {});
});

test('the final pin says FINAL/OT and the score, at the horn', function() {
  var p = setup();
  var g = game(1, -2.5, { gameState: 'OFF', gameOutcome: { lastPeriodType: 'OT' },
                          awayTeam: { abbrev: 'BOS', score: 3 }, homeTeam: { abbrev: 'TOR', score: 2 } });
  p.sync({ BOS: f.schedule(g) });
  var pin = p.timeline.pins['nhl-final-1'];
  assert.strictEqual(pin.layout.title, 'FINAL/OT');
  assert.strictEqual(pin.layout.scoreAway, '3');
  assert.strictEqual(pin.time, new Date(NOW).toISOString());
});

test('a postponed game says so, and the following game is pinned', function() {
  var p = setup();
  var ppd = game(2, 26), after = game(3, 50);
  p.sync({ BOS: f.schedule(ppd, after) });
  ppd.gameScheduleState = 'PPD';
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(ppd, after) }), ['put nhl-game-2', 'put nhl-game-3']);
  assert.strictEqual(p.timeline.pins['nhl-game-2'].layout.subtitle, 'POSTPONED');
});

test('a rescheduled game moves and loses its status', function() {
  var p = setup();
  var g = game(2, 26, { gameScheduleState: 'PPD' }), after = game(3, 50);
  p.sync({ BOS: f.schedule(after) });
  p.localStorage.setItem('pinnedUpcoming', JSON.stringify({ 2: { start: g.startTimeUTC, sent: 'x', off: true }, 3: JSON.parse(p.localStorage.getItem('pinnedUpcoming'))[3] }));
  g.gameScheduleState = 'OK';
  at(g, 200);
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(after, g) }), ['put nhl-game-2']);
  assert.strictEqual(p.timeline.pins['nhl-game-2'].time, g.startTimeUTC);
  assert.strictEqual(p.timeline.pins['nhl-game-2'].layout.subtitle, undefined);
});

test('a suspended game says so with the score, and gets no final pin', function() {
  var p = setup();
  var g = game(9, 0.1, { awayTeam: { abbrev: 'MTL', score: 2 }, homeTeam: { abbrev: 'NYR', score: 3 } });
  p.sync({ MTL: f.schedule(g) });
  g.gameState = 'OFF';
  g.gameScheduleState = 'SUSP';
  assert.deepStrictEqual(p.sync({ MTL: f.schedule(g) }, {}, true, NOW + H), ['put nhl-game-9']);
  var layout = p.timeline.pins['nhl-game-9'].layout;
  assert.strictEqual(layout.subtitle, 'SUSPENDED');
  assert.strictEqual(layout.scoreAway + '-' + layout.scoreHome, '2-3');
});

test('unfollowing a team removes its upcoming pins, called off or not, but not its finals', function() {
  var p = setup();
  var done = game(8, -3, { gameState: 'OFF' }), ppd = game(9, -1, { gameScheduleState: 'PPD' }), next = game(10, 30);
  p.sync({ MTL: f.schedule(ppd, next) });
  p.localStorage.setItem('pinnedUpcoming', JSON.stringify(Object.assign(JSON.parse(p.localStorage.getItem('pinnedUpcoming')),
    { 9: { start: ppd.startTimeUTC, sent: 'x', off: true } })));
  p.sync({ MTL: f.schedule(done, ppd, next) });
  assert.deepStrictEqual(p.sync({ BOS: f.schedule() }).sort(), ['remove nhl-game-10', 'remove nhl-game-9']);
  assert.deepStrictEqual(p.ids(), ['nhl-final-8']);
});

test('turning pins off removes upcoming pins and pins nothing new; finals stay', function() {
  var p = setup();
  var done = game(1, -3, { gameState: 'OFF' }), next = game(2, 26);
  p.sync({ BOS: f.schedule(done, next) });
  assert.deepStrictEqual(p.ids(), ['nhl-final-1', 'nhl-game-2']);
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(done, next) }, {}, false), ['remove nhl-game-2']);
  var another = game(3, -2, { gameState: 'OFF' });
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(done, another, next) }, {}, false), []);
});

test('turning pins back on pins the next game and a final from the last 6 hours only', function() {
  var p = setup();
  var old = game(1, -30, { gameState: 'OFF' }), recent = game(2, -3, { gameState: 'OFF' }), next = game(3, 26);
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(old, recent, next) }), ['put nhl-final-2', 'put nhl-game-3']);
});

test('pins saved by the version before keep working', function() {
  var p = setup();
  var next = game(3, 26);
  p.localStorage.setItem('pinnedUpcoming', JSON.stringify({ 3: next.startTimeUTC }));
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(next) }), ['put nhl-game-3'], 'sent once to record it whole');
  assert.deepStrictEqual(p.sync({ BOS: f.schedule(next) }), []);
});
