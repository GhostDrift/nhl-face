var test = require('node:test');
var assert = require('node:assert');
var keys = require('message_keys');
var settings = require('../src/pkjs/settings');
var fakeLocalStorage = require('./fixtures').fakeLocalStorage;

test('before the settings page is ever saved', function() {
  assert.deepStrictEqual(settings.read(fakeLocalStorage()), {
    followedTeams: ['VGK'],
    classics: {},
    awayColors: true,
    showShots: true,
    goalVibe: 'off',
    goalBanner: false,
    bannerSecs: 30,
    vibeOnPeriod: false,
    vibeOnFinal: false,
    vibeOnDisconnect: false
  });
});

test('followed teams skip repeats, none and unknown teams', function() {
  var ls = fakeLocalStorage({ team: 'BOS', team2: 'BOS', team3: 'TOR' });
  assert.deepStrictEqual(settings.read(ls).followedTeams, ['BOS', 'TOR']);
  ls = fakeLocalStorage({ team: 'XXX', team2: 'none', team3: 'MTL' });
  assert.deepStrictEqual(settings.read(ls).followedTeams, ['VGK', 'MTL']);
});

test('the old settings from before release are ignored', function() {
  var ls = fakeLocalStorage({ kingsClassic: '1', vibeOnGoal: '1', goalNotify: '1' });
  var s = settings.read(ls);
  assert.strictEqual(s.classics.LAK, undefined);
  assert.strictEqual(s.goalVibe, 'off');
  assert.strictEqual(s.goalBanner, false);
});

test('saved settings page answers read back', function() {
  var values = {};
  values[keys.ConfigTeam] = 'LAK';
  values[keys.ConfigTeam2] = 'ANA';
  values[keys.ConfigTeam3] = 'none';
  values[keys.ConfigAwayColors] = false;
  values[keys.ConfigShowShots] = false;
  values[keys.ConfigClassicLAK] = '1998';
  values[keys.ConfigVibeOnGoal] = 'both';
  values[keys.ConfigGoalBanner] = true;
  values[keys.ConfigBannerSecs] = '45';
  values[keys.ConfigVibeOnPeriod] = true;
  values[keys.ConfigVibeOnFinal] = true;
  values[keys.VibeOnDisconnect] = true;
  var ls = fakeLocalStorage();
  settings.saveFromConfig(ls, values);
  var s = settings.read(ls);
  assert.deepStrictEqual(s.followedTeams, ['LAK', 'ANA']);
  assert.strictEqual(s.classics.LAK, '1998');
  assert.strictEqual(s.classics.ANA, 'current');
  assert.strictEqual(s.awayColors, false);
  assert.strictEqual(s.showShots, false);
  assert.strictEqual(s.goalVibe, 'both');
  assert.strictEqual(s.goalBanner, true);
  assert.strictEqual(s.bannerSecs, 45);
  assert.strictEqual(s.vibeOnPeriod, true);
  assert.strictEqual(s.vibeOnFinal, true);
  assert.strictEqual(s.vibeOnDisconnect, true);
});
