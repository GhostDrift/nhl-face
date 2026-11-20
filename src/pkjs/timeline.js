// Pins followed teams' final scores to the watch's timeline, so a result that gets
// bumped off the face by another team's game can still be found by scrolling back.

var PIN_API = 'https://timeline-api.rebble.io/v1/user/pins/';
// How many pinned game ids to remember, so the list doesn't grow forever. Three teams'
// worth of a few days of games is plenty, since only recent finals are pinned.
var PINNED_MAX = 30;
// The schedule doesn't say when a game ended, so a final is pinned when it's first
// seen, which is within a minute or so while any followed game is live. Seen later
// than this after puck drop, the phone was likely offline at the horn, so the pin
// goes at a typical game's length instead.
var LATE_FINAL_MS = 4 * 60 * 60 * 1000;
var TYPICAL_GAME_MS = (2 * 60 + 40) * 60 * 1000;

function endTime(game) {
  var start = Date.parse(game.startTimeUTC);
  var now = Date.now();
  return now - start <= LATE_FINAL_MS ? now : start + TYPICAL_GAME_MS;
}

function pinnedIds() {
  try { return JSON.parse(localStorage.getItem('pinnedFinals')) || []; } catch (e) { return []; }
}

function markPinned(id) {
  var ids = pinnedIds().filter(function(x) { return x !== id; });
  ids.push(id);
  localStorage.setItem('pinnedFinals', JSON.stringify(ids.slice(-PINNED_MAX)));
}

function buildPin(game) {
  var last = game.gameOutcome && game.gameOutcome.lastPeriodType;
  var title = 'FINAL' + (last && last !== 'REG' ? '/' + last : '');
  var away = game.awayTeam, home = game.homeTeam;
  return {
    id: 'nhl-final-' + game.id,
    time: new Date(endTime(game)).toISOString(),
    layout: {
      type: 'sportsPin',
      title: title,
      subtitle: away.abbrev + ' @ ' + home.abbrev,
      tinyIcon: 'system://images/HOCKEY_GAME',
      largeIcon: 'system://images/HOCKEY_GAME',
      nameAway: away.abbrev,
      nameHome: home.abbrev,
      scoreAway: String(away.score || 0),
      scoreHome: String(home.score || 0),
      sportsGameState: 'in-game'
    }
  };
}

function putPin(token, pin, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function() {
    callback(xhr.status >= 200 && xhr.status < 300 ? null : new Error('Pin HTTP ' + xhr.status + ': ' + xhr.responseText));
  };
  xhr.onerror = function() { callback(new Error('Network error pinning ' + pin.id)); };
  xhr.ontimeout = xhr.onerror;
  xhr.open('PUT', PIN_API + encodeURIComponent(pin.id));
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-User-Token', token);
  xhr.timeout = 15000;
  xhr.send(JSON.stringify(pin));
}

// Pins each finished game in games not pinned yet. Games two followed teams share
// are pinned once. A pin that fails is tried again on the next update.
function pinFinals(games) {
  var pinned = pinnedIds();
  var seen = {};
  var todo = games.filter(function(g) {
    if (!g || seen[g.id] || pinned.indexOf(g.id) >= 0) return false;
    seen[g.id] = true;
    return true;
  });
  if (!todo.length || !Pebble.getTimelineToken) return;
  Pebble.getTimelineToken(function(token) {
    todo.forEach(function(game) {
      putPin(token, buildPin(game), function(err) {
        if (err) console.log(err.message); else markPinned(game.id);
      });
    });
  }, function(err) {
    console.log('No timeline token: ' + err);
  });
}

module.exports = { pinFinals: pinFinals };
