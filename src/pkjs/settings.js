// What the user picks on the settings page, as kept in the phone's localStorage. Only
// settings live here; what the app remembers for itself (the shown team, the last
// score seen) doesn't. localStorage is the phone's, or in tests anything with getItem
// and setItem.

var teams = require('./teams');
var keys = require('message_keys');

// Team 1 when none has been picked yet.
var DEFAULT_TEAM = 'VGK';
// How long the watch shows the goal banner unless set otherwise.
var BANNER_SECS = 30;

// The followed teams, team 1 first, without repeats or unknown teams.
function followedTeams(localStorage) {
  var first = localStorage.getItem('team');
  var list = [teams[first] ? first : DEFAULT_TEAM];
  ['team2', 'team3'].forEach(function(key) {
    var team = localStorage.getItem(key);
    if (teams[team] && list.indexOf(team) < 0) list.push(team);
  });
  return list;
}

// Every setting:
//   followedTeams: up to three team abbreviations, team 1 first.
//   classics: the classic color scheme id picked for each team that has them, by
//     abbreviation, or missing for the team's current colors.
//   awayColors, showShots: on unless turned off.
//   goalVibe: which goals to buzz for, 'off', 'mine' or 'both'.
//   goalBanner: whether to show the goal banner; bannerSecs, for how long.
//   vibeOnPeriod, vibeOnFinal, vibeOnDisconnect: off unless turned on.
//   pinsOn: whether to pin games to the timeline, on unless turned off.
function read(localStorage) {
  var classics = {};
  Object.keys(teams).forEach(function(abbr) {
    var id = teams[abbr].classics && localStorage.getItem('classic' + abbr);
    if (id) classics[abbr] = id;
  });
  var vibe = localStorage.getItem('goalVibe');
  return {
    followedTeams: followedTeams(localStorage),
    classics: classics,
    awayColors: localStorage.getItem('awayColors') !== '0',
    showShots: localStorage.getItem('showShots') !== '0',
    goalVibe: vibe === 'mine' || vibe === 'both' ? vibe : 'off',
    goalBanner: localStorage.getItem('goalAlert') === 'banner',
    bannerSecs: parseInt(localStorage.getItem('bannerSecs'), 10) || BANNER_SECS,
    vibeOnPeriod: localStorage.getItem('vibeOnPeriod') === '1',
    vibeOnFinal: localStorage.getItem('vibeOnFinal') === '1',
    vibeOnDisconnect: localStorage.getItem('vibeOnDisconnect') === '1',
    pinsOn: localStorage.getItem('pinNext') !== '0'
  };
}

// Keeps values, the settings page's answers by message key, as Clay's getSettings
// gives them.
function saveFromConfig(localStorage, values) {
  var team = values[keys.ConfigTeam];
  if (teams[team]) localStorage.setItem('team', team);
  localStorage.setItem('team2', values[keys.ConfigTeam2] || 'none');
  localStorage.setItem('team3', values[keys.ConfigTeam3] || 'none');
  localStorage.setItem('awayColors', values[keys.ConfigAwayColors] ? '1' : '0');
  localStorage.setItem('showShots', values[keys.ConfigShowShots] ? '1' : '0');
  Object.keys(teams).forEach(function(abbr) {
    if (teams[abbr].classics) localStorage.setItem('classic' + abbr, values[keys['ConfigClassic' + abbr]] || 'current');
  });
  var vibe = values[keys.ConfigVibeOnGoal];
  localStorage.setItem('goalVibe', vibe === 'mine' || vibe === 'both' ? vibe : 'off');
  localStorage.setItem('goalAlert', values[keys.ConfigGoalBanner] ? 'banner' : 'off');
  localStorage.setItem('bannerSecs', String(parseInt(values[keys.ConfigBannerSecs], 10) || BANNER_SECS));
  localStorage.setItem('vibeOnPeriod', values[keys.ConfigVibeOnPeriod] ? '1' : '0');
  localStorage.setItem('vibeOnFinal', values[keys.ConfigVibeOnFinal] ? '1' : '0');
  localStorage.setItem('vibeOnDisconnect', values[keys.VibeOnDisconnect] ? '1' : '0');
  localStorage.setItem('pinNext', values[keys.ConfigPinNext] ? '1' : '0');
}

module.exports = { read: read, saveFromConfig: saveFromConfig };
