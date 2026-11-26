// The watch's timeline: each followed team's next game pinned at puck drop as an
// upcoming pin, replaced by a final pin with the score when the game ends, so a result
// bumped off the face can still be found by scrolling back. See GLOSSARY.md.
//
// Pins are only removed when a final pin replaces an upcoming one, when a team stops
// being followed, or when pins are turned off in settings.
//
// The pins module decides which pins should be on the timeline; a timeline adapter
// puts them there: rebbleTimeline on the phone, or a stand-in in tests.

var schedule = require('./schedule');
var teamGames = schedule.teamGames, isLive = schedule.isLive, isOver = schedule.isOver;

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
// What a called-off game's upcoming pin says, by schedule state.
var CALLED_OFF = { PPD: 'POSTPONED', SUSP: 'SUSPENDED', CNCL: 'CANCELLED' };

function calledOff(game) {
  return CALLED_OFF[game.gameScheduleState] || null;
}

// The Rebble timeline, for the user the phone's Pebble app is signed in as. put(pin,
// callback) adds or replaces a pin, remove(id, callback) deletes one, and each calls
// back with an error or null. Removing a pin that's already gone isn't an error.
function rebbleTimeline() {
  var token = null;
  function withToken(callback) {
    if (token) { callback(null, token); return; }
    if (!Pebble.getTimelineToken) { callback(new Error('No timeline on this phone')); return; }
    Pebble.getTimelineToken(function(t) {
      token = t;
      callback(null, t);
    }, function(err) {
      callback(new Error('No timeline token: ' + err));
    });
  }
  function send(id, pin, callback) {
    withToken(function(err, t) {
      if (err) { callback(err); return; }
      var xhr = new XMLHttpRequest();
      xhr.onload = function() {
        var ok = (xhr.status >= 200 && xhr.status < 300) || (!pin && xhr.status === 404);
        callback(ok ? null : new Error('Pin HTTP ' + xhr.status + ' for ' + id + ': ' + xhr.responseText));
      };
      xhr.onerror = function() { callback(new Error('Network error for pin ' + id)); };
      xhr.ontimeout = xhr.onerror;
      xhr.open(pin ? 'PUT' : 'DELETE', PIN_API + encodeURIComponent(id));
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-User-Token', t);
      xhr.timeout = 15000;
      xhr.send(pin ? JSON.stringify(pin) : null);
    });
  }
  return {
    put: function(pin, callback) { send(pin.id, pin, callback); },
    remove: function(id, callback) { send(id, null, callback); }
  };
}

function upcomingId(id) {
  return 'nhl-game-' + id;
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

function finalEnd(game, now) {
  var start = Date.parse(game.startTimeUTC);
  return now - start <= LATE_FINAL_MS ? now : start + TYPICAL_GAME_MS;
}

function finalPin(game, now) {
  var last = game.gameOutcome && game.gameOutcome.lastPeriodType;
  var away = game.awayTeam, home = game.homeTeam;
  return {
    id: 'nhl-final-' + game.id,
    time: new Date(finalEnd(game, now)).toISOString(),
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

// An upcoming pin still changes until puck drop, and a called-off game's pin until the
// game is played.
function stillChanging(game) {
  return (!isLive(game) && !isOver(game)) || !!calledOff(game);
}

// The pins module: keeps the timeline's pins for the followed teams' games, putting
// them on timeline, an adapter like rebbleTimeline's. What's been pinned is kept in
// localStorage, the phone's or a stand-in's:
//   pinnedFinals: game ids with a final pin, the last PINNED_MAX.
//   pinnedUpcoming: game id: { start, sent, off } for each upcoming pin, sent being
//     the pin as last put, and off whether the game was called off.
function createPins(deps) {
  var timeline = deps.timeline, localStorage = deps.localStorage;

  function load(key, empty) {
    try { return JSON.parse(localStorage.getItem(key)) || empty; } catch (e) { return empty; }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
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

  function removeUpcoming(id) {
    timeline.remove(upcomingId(id), function(err) {
      if (err) console.log(err.message); else saveUpcoming(id, null);
    });
  }

  // Pins each recent final in games not pinned yet, then removes its upcoming pin.
  // Games two followed teams share are pinned once. A pin that fails is tried again
  // on the next sync, and its upcoming pin stays until it's in.
  function pinFinals(games, now) {
    var pinned = load('pinnedFinals', []);
    var seen = {};
    games.filter(function(g) {
      if (!g || seen[g.id] || pinned.indexOf(g.id) >= 0) return false;
      seen[g.id] = true;
      return true;
    }).forEach(function(game) {
      timeline.put(finalPin(game, now), function(err) {
        if (err) { console.log(err.message); return; }
        var ids = load('pinnedFinals', []).filter(function(x) { return x !== game.id; });
        ids.push(game.id);
        save('pinnedFinals', ids.slice(-PINNED_MAX));
        if (loadUpcoming()[game.id]) removeUpcoming(game.id);
      });
    });
  }

  // Keeps an upcoming pin for each followed team's next game, from schedules. A game
  // two teams share is pinned once. A game keeps its pin up to date until puck drop,
  // so it moves if the game is rescheduled, says if it's called off, and shows
  // records as they change. A delayed puck drop keeps the pin, and the team's
  // following game is pinned too. Pins are removed when the game's final pin is in,
  // when no followed team plays in the game any more, or with on false, for every
  // game not finished.
  function pinUpcoming(schedules, records, on, now) {
    var pinned = loadUpcoming();
    var finals = load('pinnedFinals', []);
    var games = {}, wanted = {};
    Object.keys(schedules).forEach(function(team) {
      schedules[team].games.forEach(function(g) { games[g.id] = g; });
      var next = on && teamGames(schedules[team], now).next;
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
    var removes = Object.keys(pinned).filter(function(id) {
      var game = games[id];
      if (finals.indexOf(Number(id)) >= 0) return true;
      if (!on) return !game || !isOver(game);
      // Unfollowed: no followed team's schedule has the game, and it's still to come.
      return !game && (Date.parse(pinned[id].start) > now || pinned[id].off);
    });
    // Forget pins long past with nothing left to change, so the list stays short.
    Object.keys(pinned).forEach(function(id) {
      if (wanted[id] || removes.indexOf(id) >= 0) return;
      if (now - Date.parse(pinned[id].start) > UPCOMING_KEEP_MS) delete pinned[id];
    });
    save('pinnedUpcoming', pinned);

    puts.forEach(function(p) {
      timeline.put(p.pin, function(err) {
        if (err) console.log(err.message);
        else saveUpcoming(p.id, { start: games[p.id].startTimeUTC, sent: p.sent, off: !!calledOff(games[p.id]) });
      });
    });
    removes.forEach(removeUpcoming);
  }

  // Brings the timeline up to date with schedules, each followed team's season
  // schedule by abbreviation, and records, each team's W-L-OTL by abbreviation, for
  // the pins. With on false, pins are turned off: nothing new is pinned, and upcoming
  // pins for games not finished are removed.
  function sync(schedules, records, on, now) {
    if (on) {
      pinFinals(Object.keys(schedules).map(function(team) {
        return teamGames(schedules[team], now).recentFinal;
      }), now);
    }
    pinUpcoming(schedules, records, on, now);
  }

  return { sync: sync };
}

module.exports = { createPins: createPins, rebbleTimeline: rebbleTimeline };
