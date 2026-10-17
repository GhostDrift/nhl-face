var Clay = require('pebble-clay');
var clayConfig = require('./config');
var teams = require('./teams');
var keys = require('message_keys');

var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var API = 'https://api-web.nhle.com/v1';
var STATE_NONE = 0, STATE_NEXT = 1, STATE_LIVE = 2, STATE_FINAL = 3;
// What the watch should buzz for, besides goals.
var BUZZ_PERIOD = 1, BUZZ_FINAL = 2;
// Game stages, in order: before puck drop, then each period in play (odd) and the
// intermission after it (even), then final.
var STAGE_PREGAME = 0, STAGE_FINAL = 99;
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

function colorDistance(a, b) {
  var dr = ((a >> 16) & 0xFF) - ((b >> 16) & 0xFF);
  var dg = ((a >> 8) & 0xFF) - ((b >> 8) & 0xFF);
  var db = (a & 0xFF) - (b & 0xFF);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Home colors normally; on the day of an away game, the away-jersey look: white where
// the main color goes, the main color where the second color goes, and a pinstripe
// that stands out from both.
function teamColors(info, away) {
  if (!away) {
    return { primary: info.primary, secondary: info.secondary, tertiary: info.tertiary };
  }
  var primary = 0xFFFFFF, secondary = info.primary;
  var tertiary = 0x000000;
  var candidates = [info.secondary, info.tertiary];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (colorDistance(c, primary) > 100 && colorDistance(c, secondary) > 100) {
      tertiary = c;
      break;
    }
  }
  return { primary: primary, secondary: secondary, tertiary: tertiary };
}

function setColors(msg, colors) {
  msg[keys.ColorPrimary] = colors.primary;
  msg[keys.ColorSecondary] = colors.secondary;
  msg[keys.ColorTertiary] = colors.tertiary;
  msg[keys.ColorText] = textColorFor(colors.primary);
  msg[keys.ColorText2] = textColorFor(colors.secondary);
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

// True when the team plays an away game today, phone local time.
function awayToday(team, schedule) {
  var today = new Date().toDateString();
  return schedule.games.some(function(g) {
    return g.gameScheduleState !== 'CNCL' && g.awayTeam.abbrev === team &&
           new Date(Date.parse(g.startTimeUTC)).toDateString() === today;
  });
}

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
    msg[keys.Record] = row.wins + '-' + row.losses + '-' + row.otLosses;
    msg[keys.Points] = String(row.points);
    msg[keys.DivName] = row.divisionName.substring(0, 3).toUpperCase();
    msg[keys.DivRank] = ordinal(row.divisionSequence);
    msg[keys.LeagueRank] = ordinal(row.leagueSequence);
  } else {
    msg[keys.Record] = '';
    msg[keys.Points] = '';
    msg[keys.DivName] = '';
    msg[keys.DivRank] = '';
    msg[keys.LeagueRank] = '';
  }
  return msg;
}

// True when the team's score in this game went up since the last check. The first
// look at a game only records its score, so joining mid-game doesn't buzz.
function teamScored(team, game) {
  if (!game) return false;
  var side = game.homeTeam.abbrev === team ? game.homeTeam : game.awayTeam;
  var score = side.score || 0;
  var last = null;
  try { last = JSON.parse(localStorage.getItem('lastScore')); } catch (e) {}
  localStorage.setItem('lastScore', JSON.stringify({ id: game.id, score: score }));
  return !!last && last.id === game.id && score > last.score;
}

// The tracked game's current stage, or null when it can't be told this update.
function gameStage(picked, liveScore) {
  if (picked.live) {
    if (!liveScore || !liveScore.periodDescriptor) return null;
    var stage = liveScore.periodDescriptor.number * 2 - 1;
    if (liveScore.clock && liveScore.clock.inIntermission) stage += 1;
    return { id: picked.live.id, stage: stage };
  }
  if (picked.recent) return { id: picked.recent.id, stage: STAGE_FINAL };
  if (picked.next) return { id: picked.next.id, stage: STAGE_PREGAME };
  return null;
}

// BUZZ_PERIOD or BUZZ_FINAL when the game moved into a new period or ended since
// the last check, else 0. Only changes seen happen count, so joining late doesn't buzz.
function stageBuzz(picked, liveScore) {
  var cur = gameStage(picked, liveScore);
  if (!cur) return 0;
  var last = null;
  try { last = JSON.parse(localStorage.getItem('lastStage')); } catch (e) {}
  localStorage.setItem('lastStage', JSON.stringify(cur));
  if (!last || last.id !== cur.id || cur.stage <= last.stage) return 0;
  if (cur.stage === STAGE_FINAL) return last.stage > STAGE_PREGAME ? BUZZ_FINAL : 0;
  return cur.stage % 2 === 1 ? BUZZ_PERIOD : 0;
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
  msg[keys.VibeOnDisconnect] = localStorage.getItem('vibeOnDisconnect') === '1' ? 1 : 0;
  setColors(msg, teamColors(info, false));

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
    var awayColors = localStorage.getItem('awayColors') !== '0';
    setColors(msg, teamColors(info, awayColors && awayToday(team, schedule)));
    function finish(liveScore) {
      var gm = buildGameFields(team, picked, liveScore);
      for (var k in gm) msg[k] = gm[k];
      // Include the just-finished game so a game-ending goal still counts.
      var scored = teamScored(team, liveScore || picked.live || picked.recent);
      if (scored && localStorage.getItem('vibeOnGoal') === '1') msg[keys.GoalScored] = 1;
      var buzz = stageBuzz(picked, liveScore);
      if ((buzz === BUZZ_PERIOD && localStorage.getItem('vibeOnPeriod') === '1') ||
          (buzz === BUZZ_FINAL && localStorage.getItem('vibeOnFinal') === '1')) {
        msg[keys.GameBuzz] = buzz;
      }
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
  if (teams[team]) localStorage.setItem('team', team);
  localStorage.setItem('awayColors', settings[keys.ConfigAwayColors] ? '1' : '0');
  localStorage.setItem('vibeOnGoal', settings[keys.ConfigVibeOnGoal] ? '1' : '0');
  localStorage.setItem('vibeOnPeriod', settings[keys.ConfigVibeOnPeriod] ? '1' : '0');
  localStorage.setItem('vibeOnFinal', settings[keys.ConfigVibeOnFinal] ? '1' : '0');
  localStorage.setItem('vibeOnDisconnect', settings[keys.VibeOnDisconnect] ? '1' : '0');
  update();
});
