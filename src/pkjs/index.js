var Clay = require('pebble-clay');
var clayConfig = require('./config');
var teams = require('./teams');
var keys = require('message_keys');

var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var API = 'https://api-web.nhle.com/v1';
var STATE_NONE = 0, STATE_NEXT = 1, STATE_LIVE = 2, STATE_FINAL = 3;
// Show a finished game's final score until this long after puck drop.
var FINAL_WINDOW_MS = 6 * 60 * 60 * 1000;

function getTeam() {
  var team = localStorage.getItem('team');
  return teams[team] ? team : 'VGK';
}

function getJSON(url, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function() {
    if (xhr.status !== 200) {
      callback(new Error('HTTP ' + xhr.status + ' for ' + url));
      return;
    }
    try {
      callback(null, JSON.parse(xhr.responseText));
    } catch (e) {
      callback(e);
    }
  };
  xhr.onerror = function() { callback(new Error('Network error for ' + url)); };
  xhr.ontimeout = xhr.onerror;
  xhr.open('GET', url);
  xhr.timeout = 15000;
  xhr.send();
}

// Black or white text, whichever reads better on the given background.
function textColorFor(rgb) {
  var r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? 0x000000 : 0xFFFFFF;
}

function ordinal(n) {
  return n + (['th', 'st', 'nd', 'rd'][n] || 'th');
}

function periodLabel(desc) {
  if (!desc) return '';
  if (desc.periodType === 'SO') return 'SO';
  if (desc.periodType === 'OT') {
    var ot = desc.number - (desc.maxRegulationPeriods || 3);
    return ot > 1 ? ot + 'OT' : 'OT';
  }
  return ordinal(desc.number);
}

function scoreLine(game) {
  return game.awayTeam.abbrev + ' ' + (game.awayTeam.score || 0) + '  @  ' +
         game.homeTeam.abbrev + ' ' + (game.homeTeam.score || 0);
}

function isLive(state) { return state === 'LIVE' || state === 'CRIT'; }
function isDone(state) { return state === 'FINAL' || state === 'OFF'; }

// Picks the game to show: a live one, a recently finished one, or the next one.
function pickGames(schedule) {
  var now = Date.now();
  var live = null, recent = null, next = null;
  schedule.games.forEach(function(g) {
    var start = Date.parse(g.startTimeUTC);
    if (isLive(g.gameState)) {
      live = g;
    } else if (isDone(g.gameState)) {
      if (now - start < FINAL_WINDOW_MS) recent = g;
    } else if (!next && g.gameScheduleState !== 'CNCL' && start > now - FINAL_WINDOW_MS) {
      next = g;
    }
  });
  return { live: live, recent: recent, next: next };
}

function buildGameFields(team, picked, liveScore) {
  var msg = {};
  var g;
  if (picked.live) {
    g = liveScore || picked.live;
    var status = periodLabel(g.periodDescriptor);
    if (g.clock) {
      status += g.clock.inIntermission ? ' INT' : ' ' + g.clock.timeRemaining;
    }
    msg[keys.GameState] = STATE_LIVE;
    msg[keys.GameLine1] = 'LIVE  ' + status;
    msg[keys.GameLine2] = scoreLine(g);
  } else if (picked.recent) {
    g = picked.recent;
    var last = g.gameOutcome && g.gameOutcome.lastPeriodType;
    msg[keys.GameState] = STATE_FINAL;
    msg[keys.GameLine1] = 'FINAL' + (last && last !== 'REG' ? '/' + last : '');
    msg[keys.GameLine2] = scoreLine(g);
  } else if (picked.next) {
    g = picked.next;
    var home = g.homeTeam.abbrev === team;
    msg[keys.GameState] = STATE_NEXT;
    msg[keys.GameStart] = Math.floor(Date.parse(g.startTimeUTC) / 1000);
    msg[keys.GameOpp] = home ? g.awayTeam.abbrev : g.homeTeam.abbrev;
    msg[keys.GameHome] = home ? 1 : 0;
  } else {
    msg[keys.GameState] = STATE_NONE;
  }
  return msg;
}

function refreshMinutes(picked) {
  if (picked.live) return 1;
  if (picked.next) {
    var mins = (Date.parse(picked.next.startTimeUTC) - Date.now()) / 60000;
    if (mins < 60) return 5;
  }
  return 30;
}

function buildStandingsFields(team, standings) {
  var msg = {};
  var row = null;
  standings.standings.forEach(function(s) {
    if (s.teamAbbrev.default === team) row = s;
  });
  if (row) {
    msg[keys.Record] = row.wins + '-' + row.losses + '-' + row.otLosses + '  ' + row.points + ' PTS';
    msg[keys.Rank] = '#' + row.leagueSequence + ' NHL  ' +
                     ordinal(row.divisionSequence) + ' ' + row.divisionName.substring(0, 3).toUpperCase();
  } else {
    msg[keys.Record] = '';
    msg[keys.Rank] = '';
  }
  return msg;
}

function sendToWatch(msg) {
  Pebble.sendAppMessage(msg, function() {
    console.log('Sent update to watch');
  }, function(e) {
    console.log('Failed to send update: ' + JSON.stringify(e));
  });
}

function update() {
  var team = getTeam();
  var info = teams[team];
  var msg = {};
  msg[keys.TeamName] = info.name.toUpperCase();
  msg[keys.ColorPrimary] = info.primary;
  msg[keys.ColorSecondary] = info.secondary;
  msg[keys.ColorText] = textColorFor(info.primary);
  msg[keys.ColorText2] = textColorFor(info.secondary);

  var pending = 2;
  var standings = null, schedule = null;
  function done() {
    if (--pending > 0) return;
    if (standings) {
      var s = buildStandingsFields(team, standings);
      for (var k in s) msg[k] = s[k];
    }
    if (!schedule) {
      msg[keys.RefreshMins] = 10;
      sendToWatch(msg);
      return;
    }
    var picked = pickGames(schedule);
    msg[keys.RefreshMins] = refreshMinutes(picked);
    function finish(liveScore) {
      var gm = buildGameFields(team, picked, liveScore);
      for (var k in gm) msg[k] = gm[k];
      sendToWatch(msg);
    }
    if (!picked.live) {
      finish(null);
      return;
    }
    // The schedule lacks the period clock, so get it from the daily scoreboard.
    getJSON(API + '/score/' + picked.live.gameDate, function(err, data) {
      var found = null;
      if (!err) {
        data.games.forEach(function(g) {
          if (g.id === picked.live.id) found = g;
        });
      }
      finish(found);
    });
  }

  getJSON(API + '/standings/now', function(err, data) {
    if (err) console.log(err.message); else standings = data;
    done();
  });
  getJSON(API + '/club-schedule-season/' + team + '/now', function(err, data) {
    if (err) console.log(err.message); else schedule = data;
    done();
  });
}

Pebble.addEventListener('ready', function() {
  update();
});

Pebble.addEventListener('appmessage', function(e) {
  if (e.payload.RequestUpdate !== undefined) update();
});

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) return;
  var settings = clay.getSettings(e.response);
  var team = settings[keys.ConfigTeam];
  if (teams[team]) {
    localStorage.setItem('team', team);
    update();
  }
});
