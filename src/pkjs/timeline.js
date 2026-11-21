// The watch's timeline: each followed team's next game pinned at puck drop, and final scores
// pinned when each game ends, so a result bumped off the face can still be found by
// scrolling back.

var PIN_API = 'https://timeline-api.rebble.io/v1/user/pins/';
var ICON = 'system://images/HOCKEY_GAME';
// How many pinned final ids to remember, so the list doesn't grow forever. Only
// recent finals are pinned, so a few days of games is plenty.
var PINNED_MAX = 30;
// The schedule doesn't say when a game ended, so a final is pinned when it's first
// seen, which is within a minute or so while the game is followed. Seen later
// than this after puck drop, the phone was likely offline at the horn, so the pin
// goes at a typical game's length instead.
var LATE_FINAL_MS = 4 * 60 * 60 * 1000;
var TYPICAL_GAME_MS = (2 * 60 + 40) * 60 * 1000;
// Upcoming game pins are forgotten this long after puck drop. They stay on the
// timeline; this only keeps the list of them short.
var UPCOMING_KEEP_MS = 24 * 60 * 60 * 1000;

function load(key, empty) {
  try { return JSON.parse(localStorage.getItem(key)) || empty; } catch (e) { return empty; }
}

// Calls back with the timeline token, or logs why there isn't one.
function withToken(callback) {
  if (!Pebble.getTimelineToken) return;
  Pebble.getTimelineToken(callback, function(err) {
    console.log('No timeline token: ' + err);
  });
}

// PUTs pin, or with pin null DELETEs the pin with id, then calls back with any error.
function send(token, id, pin, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function() {
    callback(xhr.status >= 200 && xhr.status < 300 ? null : new Error('Pin HTTP ' + xhr.status + ' for ' + id + ': ' + xhr.responseText));
  };
  xhr.onerror = function() { callback(new Error('Network error for pin ' + id)); };
  xhr.ontimeout = xhr.onerror;
  xhr.open(pin ? 'PUT' : 'DELETE', PIN_API + encodeURIComponent(id));
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-User-Token', token);
  xhr.timeout = 15000;
  xhr.send(pin ? JSON.stringify(pin) : null);
}

// Final scores

function finalEnd(game) {
  var start = Date.parse(game.startTimeUTC);
  var now = Date.now();
  return now - start <= LATE_FINAL_MS ? now : start + TYPICAL_GAME_MS;
}

function finalPin(game) {
  var last = game.gameOutcome && game.gameOutcome.lastPeriodType;
  var away = game.awayTeam, home = game.homeTeam;
  return {
    id: 'nhl-final-' + game.id,
    time: new Date(finalEnd(game)).toISOString(),
    layout: {
      type: 'sportsPin',
      title: 'FINAL' + (last && last !== 'REG' ? '/' + last : ''),
      subtitle: away.abbrev + ' @ ' + home.abbrev,
      tinyIcon: ICON,
      largeIcon: ICON,
      nameAway: away.abbrev,
      nameHome: home.abbrev,
      scoreAway: String(away.score || 0),
      scoreHome: String(home.score || 0),
      sportsGameState: 'in-game'
    }
  };
}

// Pins each finished game in games not pinned yet. Games two followed teams share
// are pinned once. A pin that fails is tried again on the next update.
function pinFinals(games) {
  var pinned = load('pinnedFinals', []);
  var seen = {};
  var todo = games.filter(function(g) {
    if (!g || seen[g.id] || pinned.indexOf(g.id) >= 0) return false;
    seen[g.id] = true;
    return true;
  });
  if (!todo.length) return;
  withToken(function(token) {
    todo.forEach(function(game) {
      var pin = finalPin(game);
      send(token, pin.id, pin, function(err) {
        if (err) { console.log(err.message); return; }
        var ids = load('pinnedFinals', []).filter(function(x) { return x !== game.id; });
        ids.push(game.id);
        localStorage.setItem('pinnedFinals', JSON.stringify(ids.slice(-PINNED_MAX)));
      });
    });
  });
}

// Each team's next game

function upcomingId(id) {
  return 'nhl-game-' + id;
}

function upcomingPin(game, records) {
  var away = game.awayTeam.abbrev, home = game.homeTeam.abbrev;
  var layout = {
    type: 'sportsPin',
    title: away + ' @ ' + home,
    tinyIcon: ICON,
    largeIcon: ICON,
    nameAway: away,
    nameHome: home,
    sportsGameState: 'pre-game'
  };
  if (records[away]) layout.recordAway = records[away];
  if (records[home]) layout.recordHome = records[home];
  return {
    id: upcomingId(game.id),
    time: new Date(Date.parse(game.startTimeUTC)).toISOString(),
    duration: TYPICAL_GAME_MS / 60000,
    layout: layout
  };
}

// The first game in games, a team's schedule in order, that hasn't started and
// isn't cancelled, however far off. Null if there isn't one.
function nextGame(games) {
  var now = Date.now();
  return games.filter(function(g) {
    return (g.gameState === 'FUT' || g.gameState === 'PRE') && g.gameScheduleState !== 'CNCL' &&
           Date.parse(g.startTimeUTC) > now;
  })[0] || null;
}

// Keeps a pin at puck drop for each followed team's next game, from schedules, a
// list of each team's games. A game two teams share is pinned once. Once a game
// starts, the team's following game is pinned. A pin moves if its start time
// changes, and a pin for a game still to come that isn't anyone's next game any
// more, such as a cancelled one or one for a team no longer followed, is removed.
// With on false, every pin for a game not started yet is removed. records maps a team's
// abbreviation to its record, for the pin. Pinned games are kept in localStorage,
// as id: start time, so each is sent once.
function pinUpcoming(schedules, records, on) {
  var pinned = load('pinnedUpcoming', {});
  var now = Date.now();
  var wanted = {}, started = {};
  schedules.forEach(function(games) {
    games.forEach(function(g) {
      if (g.gameState !== 'FUT' && g.gameState !== 'PRE') started[g.id] = true;
    });
    var next = on && nextGame(games);
    if (next) wanted[next.id] = next;
  });
  var puts = Object.keys(wanted).filter(function(id) {
    return pinned[id] !== wanted[id].startTimeUTC;
  }).map(function(id) { return wanted[id]; });
  var deletes = Object.keys(pinned).filter(function(id) {
    // A game that has started keeps its pin, even ahead of its scheduled time.
    return !wanted[id] && !started[id] && Date.parse(pinned[id]) > now;
  });
  // Forget games long started, so the list stays short.
  Object.keys(pinned).forEach(function(id) {
    if (now - Date.parse(pinned[id]) > UPCOMING_KEEP_MS) delete pinned[id];
  });
  localStorage.setItem('pinnedUpcoming', JSON.stringify(pinned));
  if (!puts.length && !deletes.length) return;

  function save(id, start) {
    var cur = load('pinnedUpcoming', {});
    if (start) cur[id] = start; else delete cur[id];
    localStorage.setItem('pinnedUpcoming', JSON.stringify(cur));
  }
  withToken(function(token) {
    puts.forEach(function(game) {
      send(token, upcomingId(game.id), upcomingPin(game, records), function(err) {
        if (err) console.log(err.message); else save(game.id, game.startTimeUTC);
      });
    });
    deletes.forEach(function(id) {
      send(token, upcomingId(id), null, function(err) {
        // Already gone counts as removed.
        if (err && !/HTTP 404/.test(err.message)) console.log(err.message); else save(id, null);
      });
    });
  });
}

module.exports = { pinFinals: pinFinals, pinUpcoming: pinUpcoming };
