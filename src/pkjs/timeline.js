// The watch's timeline: each followed team's next game pinned at puck drop as an
// upcoming pin, replaced by a final pin with the score when the game ends, so a result
// bumped off the face can still be found by scrolling back. See GLOSSARY.md.
//
// Pins are only removed when a final pin replaces an upcoming one, when a team stops
// being followed, or when pins are turned off in settings.

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
// Upcoming pins are forgotten this long after puck drop once there's nothing left to
// update on them. They stay on the timeline; this only keeps the list of them short.
var UPCOMING_KEEP_MS = 24 * 60 * 60 * 1000;
// A game called off, by its schedule state, and what its upcoming pin says.
var CALLED_OFF = { PPD: 'POSTPONED', SUSP: 'SUSPENDED', CNCL: 'CANCELLED' };

function load(key, empty) {
  try { return JSON.parse(localStorage.getItem(key)) || empty; } catch (e) { return empty; }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function notStarted(game) {
  return game.gameState === 'FUT' || game.gameState === 'PRE';
}

function isDone(game) {
  return game.gameState === 'FINAL' || game.gameState === 'OFF';
}

function calledOff(game) {
  return CALLED_OFF[game.gameScheduleState] || null;
}

// Calls back with the timeline token, or logs why there isn't one.
function withToken(callback) {
  if (!Pebble.getTimelineToken) return;
  Pebble.getTimelineToken(callback, function(err) {
    console.log('No timeline token: ' + err);
  });
}

// PUTs pin, or with pin null DELETEs the pin with id, then calls back with any error.
// Deleting a pin that's already gone counts as success.
function send(token, id, pin, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function() {
    var ok = (xhr.status >= 200 && xhr.status < 300) || (!pin && xhr.status === 404);
    callback(ok ? null : new Error('Pin HTTP ' + xhr.status + ' for ' + id + ': ' + xhr.responseText));
  };
  xhr.onerror = function() { callback(new Error('Network error for pin ' + id)); };
  xhr.ontimeout = xhr.onerror;
  xhr.open(pin ? 'PUT' : 'DELETE', PIN_API + encodeURIComponent(id));
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-User-Token', token);
  xhr.timeout = 15000;
  xhr.send(pin ? JSON.stringify(pin) : null);
}

// Upcoming pins, kept in localStorage as game id: { start, sent, off }, sent being the
// pin as last PUT, so each change is sent once, and off whether the game was called off.

function upcomingId(id) {
  return 'nhl-game-' + id;
}

function loadUpcoming() {
  var pinned = load('pinnedUpcoming', {});
  // Before pins were tracked whole, each was kept as just its start time.
  Object.keys(pinned).forEach(function(id) {
    if (typeof pinned[id] === 'string') pinned[id] = { start: pinned[id], sent: '', off: false };
  });
  return pinned;
}

// Records a sent upcoming pin for game id, or with entry null, that it's gone.
function saveUpcoming(id, entry) {
  var pinned = loadUpcoming();
  if (entry) pinned[id] = entry; else delete pinned[id];
  save('pinnedUpcoming', pinned);
}

function deleteUpcoming(token, id) {
  send(token, upcomingId(id), null, function(err) {
    if (err) console.log(err.message); else saveUpcoming(id, null);
  });
}

// The upcoming pin for game: at puck drop with both teams' records, or for a game
// called off, saying so, with the score so far for a suspended one.
function upcomingPin(game, records) {
  var away = game.awayTeam, home = game.homeTeam;
  var layout = {
    type: 'sportsPin',
    title: away.abbrev + ' @ ' + home.abbrev,
    tinyIcon: ICON,
    largeIcon: ICON,
    nameAway: away.abbrev,
    nameHome: home.abbrev,
    sportsGameState: 'pre-game'
  };
  if (records[away.abbrev]) layout.recordAway = records[away.abbrev];
  if (records[home.abbrev]) layout.recordHome = records[home.abbrev];
  var status = calledOff(game);
  if (status) layout.subtitle = status;
  if (status && game.gameScheduleState === 'SUSP') {
    layout.sportsGameState = 'in-game';
    layout.scoreAway = String(away.score || 0);
    layout.scoreHome = String(home.score || 0);
  }
  return {
    id: upcomingId(game.id),
    time: new Date(Date.parse(game.startTimeUTC)).toISOString(),
    duration: TYPICAL_GAME_MS / 60000,
    layout: layout
  };
}

// The team's next game, from games, its schedule in order: the first one whose puck
// drop is still ahead and that hasn't been called off. Null if there isn't one.
function nextGame(games) {
  var now = Date.now();
  return games.filter(function(g) {
    return notStarted(g) && !calledOff(g) && Date.parse(g.startTimeUTC) > now;
  })[0] || null;
}

// An upcoming pin still changes until puck drop, and a called-off game's pin until the
// game is played.
function stillChanging(game) {
  return notStarted(game) || !!calledOff(game);
}

// Keeps an upcoming pin for each followed team's next game, from schedules, a list of
// each followed team's games. A game two teams share is pinned once. A game keeps its
// pin up to date until puck drop, so it moves if the game is rescheduled, says if it's
// called off, and shows records, from records by team abbreviation, as they change.
// A delayed puck drop keeps the pin, and the team's following game is pinned too.
// Pins are removed when the game's final pin is in, when no followed team plays in
// the game any more, or with on false, for every game not finished.
function pinUpcoming(schedules, records, on) {
  var pinned = loadUpcoming();
  var finals = load('pinnedFinals', []);
  var now = Date.now();
  var games = {}, wanted = {};
  schedules.forEach(function(schedule) {
    schedule.forEach(function(g) { games[g.id] = g; });
    var next = on && nextGame(schedule);
    if (next) wanted[next.id] = true;
  });
  if (on) {
    Object.keys(pinned).forEach(function(id) {
      if (games[id] && stillChanging(games[id])) wanted[id] = true;
    });
  }

  var puts = [];
  Object.keys(wanted).forEach(function(id) {
    var pin = upcomingPin(games[id], records);
    var sent = JSON.stringify(pin);
    if (!pinned[id] || pinned[id].sent !== sent) puts.push({ id: id, pin: pin, sent: sent });
  });
  var deletes = Object.keys(pinned).filter(function(id) {
    var game = games[id];
    if (finals.indexOf(Number(id)) >= 0) return true;
    if (!on) return !game || !isDone(game);
    // Unfollowed: no followed team's schedule has the game, and it's still to come.
    return !game && (Date.parse(pinned[id].start) > now || pinned[id].off);
  });
  // Forget pins long past with nothing left to change, so the list stays short.
  Object.keys(pinned).forEach(function(id) {
    if (wanted[id] || deletes.indexOf(id) >= 0) return;
    if (now - Date.parse(pinned[id].start) > UPCOMING_KEEP_MS) delete pinned[id];
  });
  save('pinnedUpcoming', pinned);
  if (!puts.length && !deletes.length) return;

  withToken(function(token) {
    puts.forEach(function(p) {
      send(token, p.pin.id, p.pin, function(err) {
        if (err) console.log(err.message);
        else saveUpcoming(p.id, { start: games[p.id].startTimeUTC, sent: p.sent, off: !!calledOff(games[p.id]) });
      });
    });
    deletes.forEach(function(id) { deleteUpcoming(token, id); });
  });
}

// Final pins

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

// Pins each finished game in games not pinned yet, then removes its upcoming pin. A
// game called off isn't finished, even if its state says so. Games two followed
// teams share are pinned once. A pin that fails is tried again on the next update,
// and its upcoming pin stays until it's in. Nothing is pinned with on false.
function pinFinals(games, on) {
  if (!on) return;
  var pinned = load('pinnedFinals', []);
  var seen = {};
  var todo = games.filter(function(g) {
    if (!g || !isDone(g) || calledOff(g) || seen[g.id] || pinned.indexOf(g.id) >= 0) return false;
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
        save('pinnedFinals', ids.slice(-PINNED_MAX));
        if (loadUpcoming()[game.id]) deleteUpcoming(token, game.id);
      });
    });
  });
}

module.exports = { pinFinals: pinFinals, pinUpcoming: pinUpcoming };
