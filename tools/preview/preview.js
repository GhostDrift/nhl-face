// Preview build only (tools/preview.sh): sends the watch every team's color schemes
// with a sample goal banner, one at a time, as its buttons ask.
var teams = require('./teams');
var colors = require('./colors');
var keys = require('message_keys');

// Every team's current colors, then its classic schemes.
var schemes = [];
Object.keys(teams).sort().forEach(function(abbr) {
  schemes.push({ team: abbr, id: 'current', info: teams[abbr] });
  (teams[abbr].classics || []).forEach(function(c) {
    schemes.push({ team: abbr, id: c.id, info: c });
  });
});

var index = 0, away = false;

// Pick up where the last preview left off.
try {
  var last = JSON.parse(localStorage.getItem('previewScheme'));
  schemes.forEach(function(s, i) {
    if (s.team === last.team && s.id === last.id) index = i;
  });
  away = !!last.away;
} catch (e) {}

function remember() {
  var s = schemes[index];
  localStorage.setItem('previewScheme', JSON.stringify({ team: s.team, id: s.id, away: away }));
}

function send(attempt) {
  var s = schemes[index];
  var msg = {};
  msg[keys.PreviewLabel] = (s.team + ' ' + s.id + (away ? ' away' : ' home')).toUpperCase();
  msg[keys.TeamName] = teams[s.team].name.toUpperCase();
  msg[keys.TeamAbbrev] = s.team;
  colors.applyScheme(msg, s.info, away);
  msg[keys.GoalScorer] = 'J. Smith';
  msg[keys.GoalAssists] = 'A. Jones, B. Brown';
  msg[keys.GoalTime] = '2ND 12:34 PP';
  msg[keys.GoalScore] = away ? s.team + ' 2  @  OPP 1' : 'OPP 1  @  ' + s.team + ' 2';
  msg[keys.GoalBannerSecs] = 24 * 60 * 60;
  Pebble.sendAppMessage(msg, null, function() {
    // The watch may be busy with the face's own update; try again shortly.
    if ((attempt || 0) < 5) setTimeout(function() { send((attempt || 0) + 1); }, 500);
  });
}

Pebble.addEventListener('ready', function() {
  send();
});

// Down and up step through the schemes; select flips between home and away.
Pebble.addEventListener('appmessage', function(e) {
  var step = e.payload.PreviewStep;
  if (step === undefined) return;
  if (step === 0) {
    away = !away;
  } else {
    index = (index + step + schemes.length) % schemes.length;
  }
  remember();
  send();
});
