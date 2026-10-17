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
// While a game is live, check the scoreboard this often between the regular
// once-a-minute updates. The NHL feed is cached for about this long, so faster
// polling would just fetch the same data again.
var LIVE_POLL_MS = 20 * 1000;
// How long the watch shows the goal banner unless set otherwise.
var GOAL_BANNER_SECS = 30;
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

// How many goals the team scored in this game since the last check. The first look
// at a game only records its score, so joining mid-game doesn't count.
function teamScored(team, game) {
  if (!game) return 0;
  var side = game.homeTeam.abbrev === team ? game.homeTeam : game.awayTeam;
  var score = side.score || 0;
  var last = null;
  try { last = JSON.parse(localStorage.getItem('lastScore')); } catch (e) {}
  localStorage.setItem('lastScore', JSON.stringify({ id: game.id, score: score }));
  return last && last.id === game.id && score > last.score ? score - last.score : 0;
}

function abbrevOf(team) {
  return typeof team === 'string' ? team : team && team['default'];
}

// The parts of one goal from the scoreboard's goal list, for a notification or banner.
function goalParts(game, goal) {
  var tags = [];
  if (goal.strength === 'pp') tags.push('PP');
  if (goal.strength === 'sh') tags.push('SH');
  if (goal.goalModifier === 'empty-net') tags.push('EN');
  var assists = (goal.assists || []).map(function(a) { return a.name['default']; });
  return {
    team: abbrevOf(goal.teamAbbrev),
    scorer: goal.name['default'],
    assists: assists.length ? assists.join(', ') : 'Unassisted',
    time: periodLabel(goal.periodDescriptor) + ' ' + goal.timeInPeriod + (tags.length ? ' ' + tags.join(' ') : ''),
    score: bannerScore(game, goal.awayScore, goal.homeScore)
  };
}

function bannerScore(game, away, home) {
  return game.awayTeam.abbrev + ' ' + away + '  @  ' + game.homeTeam.abbrev + ' ' + home;
}

// The team's last count goals in the game.
function teamGoals(team, game, count) {
  var mine = (game.goals || []).filter(function(g) { return abbrevOf(g.teamAbbrev) === team; });
  return mine.slice(-count);
}

// Shows a notification for each of the team's last count goals in the game.
function notifyGoals(team, game, count) {
  teamGoals(team, game, count).forEach(function(goal) {
    var g = goalParts(game, goal);
    var assists = g.assists === 'Unassisted' ? ' (unassisted)' : ' (' + g.assists + ')';
    Pebble.showSimpleNotificationOnPebble(g.team + ' GOAL!', g.scorer + assists + '\n' + g.time + '\n' + g.score);
  });
}

// Adds the banner fields for the team's latest goal in the game to msg. Returns
// false if the goal isn't in the game's goal list yet.
function addGoalBanner(team, game, msg) {
  var goal = teamGoals(team, game, 1)[0];
  if (!goal) return false;
  var g = goalParts(game, goal);
  msg[keys.GoalScorer] = g.scorer;
  msg[keys.GoalAssists] = g.assists;
  msg[keys.GoalTime] = g.time;
  msg[keys.GoalScore] = g.score;
  var secs = parseInt(localStorage.getItem('bannerSecs'), 10) || GOAL_BANNER_SECS;
  msg[keys.GoalBannerSecs] = secs;
  localStorage.setItem('goalBanner', JSON.stringify({ id: game.id, score: g.score, until: Date.now() + secs * 1000 }));
  return true;
}

// Adds the game's current score to msg if it changed while the goal banner is up,
// such as the other team scoring right after. Returns true if it did.
function updateGoalBanner(game, msg) {
  var banner = null;
  try { banner = JSON.parse(localStorage.getItem('goalBanner')); } catch (e) {}
  if (!game || !banner || banner.id !== game.id || Date.now() > banner.until) return false;
  var score = scoreLine(game);
  if (score === banner.score) return false;
  banner.score = score;
  localStorage.setItem('goalBanner', JSON.stringify(banner));
  msg[keys.GoalScore] = score;
  return true;
}

// How to show the team's goals: 'off', 'notify', or 'banner'.
function goalAlert() {
  var mode = localStorage.getItem('goalAlert');
  if (mode) return mode;
  // Before the banner, this was an on/off notification setting.
  return localStorage.getItem('goalNotify') === '1' ? 'notify' : 'off';
}

// Calls back with the scoreboard entry, including its goal list, for a game.
function getScoreboardGame(game, callback) {
  getJSON(API + '/score/' + game.gameDate, function(err, data) {
    var found = null;
    if (!err) {
      data.games.forEach(function(g) {
        if (g.id === game.id) found = g;
      });
    }
    callback(found);
  });
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

// BUZZ_PERIOD or BUZZ_FINAL when a period started or ended, or the game ended, since
// the last check, else 0. Only changes seen happen count, so joining late doesn't buzz.
function stageBuzz(picked, liveScore) {
  var cur = gameStage(picked, liveScore);
  if (!cur) return 0;
  var last = null;
  try { last = JSON.parse(localStorage.getItem('lastStage')); } catch (e) {}
  localStorage.setItem('lastStage', JSON.stringify(cur));
  if (!last || last.id !== cur.id || cur.stage <= last.stage) return 0;
  if (cur.stage === STAGE_FINAL) return last.stage > STAGE_PREGAME ? BUZZ_FINAL : 0;
  return BUZZ_PERIOD;
}

// Runs the goal, period, and final checks for a game and adds whatever the watch
// should buzz for to msg; goal notifications are sent directly. liveScore is the
// game's scoreboard entry, if fetched. Returns true if anything happened.
function gameEvents(team, picked, liveScore, msg) {
  // Include the just-finished game so a game-ending goal still counts.
  var game = picked.live || picked.recent;
  var scored = teamScored(team, liveScore || game);
  if (scored && localStorage.getItem('vibeOnGoal') === '1') msg[keys.GoalScored] = 1;
  var alert = goalAlert();
  if (scored && alert === 'notify') {
    if (liveScore && liveScore.goals) {
      notifyGoals(team, liveScore, scored);
    } else {
      getScoreboardGame(game, function(found) {
        if (found) notifyGoals(team, found, scored);
      });
    }
  } else if (scored && alert === 'banner') {
    if (!liveScore || !addGoalBanner(team, liveScore, msg)) {
      getScoreboardGame(game, function(found) {
        var banner = {};
        if (found && addGoalBanner(team, found, banner)) sendToWatch(banner);
      });
    }
  }
  var rescored = !scored && alert === 'banner' && updateGoalBanner(liveScore || game, msg);
  var buzz = stageBuzz(picked, liveScore);
  if ((buzz === BUZZ_PERIOD && localStorage.getItem('vibeOnPeriod') === '1') ||
      (buzz === BUZZ_FINAL && localStorage.getItem('vibeOnFinal') === '1')) {
    msg[keys.GameBuzz] = buzz;
  }
  return scored > 0 || rescored || buzz !== 0;
}

// The live game being polled between regular updates, if any.
var livePoll = null;

function stopLivePoll() {
  if (livePoll) clearTimeout(livePoll.timer);
  livePoll = null;
}

// Polls the scoreboard for a live game and messages the watch only when there's a
// goal, a period starting or ending, or the final horn. Once the game ends, does a full update.
function startLivePoll(team, game) {
  if (livePoll && livePoll.team === team && livePoll.id === game.id) return;
  stopLivePoll();
  var poll = livePoll = { team: team, id: game.id, timer: null };
  function tick() {
    getScoreboardGame(game, function(found) {
      if (livePoll !== poll) return;
      var over = found && isDone(found.gameState);
      if (found && (isLive(found.gameState) || over)) {
        var picked = over ? { recent: found } : { live: found };
        var msg = {};
        if (gameEvents(team, picked, found, msg)) {
          var gm = buildGameFields(team, picked, found);
          for (var k in gm) msg[k] = gm[k];
          sendToWatch(msg);
        }
      }
      if (over) {
        stopLivePoll();
        update();
      } else {
        poll.timer = setTimeout(tick, LIVE_POLL_MS);
      }
    });
  }
  poll.timer = setTimeout(tick, LIVE_POLL_MS);
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
      gameEvents(team, picked, liveScore, msg);
      sendToWatch(msg);
    }
    if (!picked.live) {
      stopLivePoll();
      finish(null);
      return;
    }
    startLivePoll(team, picked.live);
    // The schedule lacks the period clock, so get it from the daily scoreboard.
    getScoreboardGame(picked.live, finish);
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
  var alert = settings[keys.ConfigGoalNotify];
  localStorage.setItem('goalAlert', alert === 'notify' || alert === 'banner' ? alert : 'off');
  localStorage.setItem('bannerSecs', String(parseInt(settings[keys.ConfigBannerSecs], 10) || GOAL_BANNER_SECS));
  localStorage.setItem('vibeOnPeriod', settings[keys.ConfigVibeOnPeriod] ? '1' : '0');
  localStorage.setItem('vibeOnFinal', settings[keys.ConfigVibeOnFinal] ? '1' : '0');
  localStorage.setItem('vibeOnDisconnect', settings[keys.VibeOnDisconnect] ? '1' : '0');
  update();
});
