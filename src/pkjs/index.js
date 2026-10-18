var Clay = require('pebble-clay');
var clayConfig = require('./config');
var teams = require('./teams');
var colors = require('./colors');
var keys = require('message_keys');

// Runs in the settings page: shows only the picked team's Classic colors option.
function clayCustom() {
  var clay = this;
  function sync() {
    var team = clay.getItemByMessageKey('ConfigTeam').get();
    clay.getAllItems().forEach(function(item) {
      if (!/^ConfigClassic/.test(item.messageKey || '')) return;
      if (item.messageKey === 'ConfigClassic' + team) item.show(); else item.hide();
    });
  }
  clay.on(clay.EVENTS.AFTER_BUILD, function() {
    clay.getItemByMessageKey('ConfigTeam').on('change', sync);
    sync();
  });
}

var clay = new Clay(clayConfig, clayCustom, { autoHandleEvents: false });

var API = 'https://api-web.nhle.com/v1';
var STATE_NONE = 0, STATE_NEXT = 1, STATE_LIVE = 2, STATE_FINAL = 3;
// What the watch should buzz for, besides goals.
var BUZZ_PERIOD = 1, BUZZ_FINAL = 2;
// Which team a goal buzz is for.
var GOAL_MINE = 1, GOAL_OPP = 2;
// Game stages, in order: before puck drop, then each period in play (odd) and the
// intermission after it (even), then final.
var STAGE_PREGAME = 0, STAGE_FINAL = 99;
// While a game is live, check the scoreboard this often between the regular
// once-a-minute updates. The NHL feed is cached for about this long, so faster
// polling would just fetch the same data again.
var LIVE_POLL_MS = 20 * 1000;
// Start polling for puck drop this long before the scheduled start. The season
// schedule is slow to show a game as live, so the scoreboard is what's watched.
var PUCK_DROP_WATCH_MS = 15 * 60 * 1000;
// During intermission, check this often until its last few minutes.
var INTERMISSION_POLL_MS = 2 * 60 * 1000;
var INTERMISSION_END_SECS = 150;
// How long the watch shows the goal banner unless set otherwise.
var GOAL_BANNER_SECS = 30;
// How many times to check for a goal that's in the score but not the goal list yet,
// LIVE_POLL_MS apart.
var GOAL_BANNER_TRIES = 9;
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

// The team's colors: its current ones, or the classic scheme picked in settings.
function teamScheme(team) {
  var info = teams[team];
  var id = localStorage.getItem('classic' + team);
  // Before the Classic colors picker, the Kings had a toggle for their 1998 scheme.
  if (!id && team === 'LAK' && localStorage.getItem('kingsClassic') === '1') id = '1998';
  var picked = (info.classics || []).filter(function(c) { return c.id === id; })[0];
  return picked || info;
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

// True when the game is about to start, or should have and isn't live yet.
function nearStart(game) {
  return !!game && Date.parse(game.startTimeUTC) - Date.now() < PUCK_DROP_WATCH_MS;
}

function refreshMinutes(picked, liveScore) {
  if (picked.live) {
    var clock = liveScore && liveScore.clock;
    return clock && clock.inIntermission ? 5 : 1;
  }
  if (picked.next) {
    var mins = (Date.parse(picked.next.startTimeUTC) - Date.now()) / 60000;
    if (mins < 60) return 5;
  }
  return 30;
}

// The stat bubbles: RECORD and PTS, then the division and league ranks. Their
// labels are sent too, since the playoffs use them for other stats.
function buildStandingsFields(team, standings) {
  var msg = {};
  msg[keys.RecordLabel] = 'RECORD';
  msg[keys.PointsLabel] = 'PTS';
  msg[keys.LeagueLabel] = 'NHL';
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

// The season whose playoffs the team is in, once its regular season is over: its
// schedule has playoff games and no regular season games left. Else null.
function playoffSeason(schedule) {
  var playoff = null;
  for (var i = 0; i < schedule.games.length; i++) {
    var g = schedule.games[i];
    if (g.gameType === 2 && !isDone(g.gameState) && g.gameScheduleState !== 'CNCL') return null;
    if (g.gameType === 3) playoff = g;
  }
  return playoff && playoff.season;
}

// Playoff labels for the big screen, and shorter ones that fit the others.
var PLAYOFF_LABELS = {
  big: { rounds: ['ROUND 1', 'ROUND 2', 'CONF FINAL', 'CUP FINAL'], game: 'GAME', record: 'PLAYOFFS', champs: 'CHAMPS' },
  small: { rounds: ['ROUND 1', 'ROUND 2', 'ROUND 3', 'FINAL'], game: 'GM', record: 'TOTAL', champs: 'WON' }
};

function bigScreen() {
  var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
  return !!info && info.platform === 'emery';
}

// The team's series in the season's bracket, in round order: the round, its wins
// (mine) and its opponent's (opp), and the wins needed to take the series.
function teamSeries(team, bracket) {
  var series = [];
  bracket.rounds.forEach(function(round) {
    round.series.forEach(function(s) {
      if (!s.topSeed || !s.bottomSeed) return;
      var top = s.topSeed.abbrev === team;
      if (!top && s.bottomSeed.abbrev !== team) return;
      series.push({
        round: s.roundNumber,
        mine: (top ? s.topSeed : s.bottomSeed).wins || 0,
        opp: (top ? s.bottomSeed : s.topSeed).wins || 0,
        needed: s.neededToWin || 4
      });
    });
  });
  return series;
}

// Where the team's season stands, for the game bubble when there's no game to show,
// as its two lines: eliminated, between playoff rounds, Cup champions, or into the
// playoffs before they start. Null if none of those.
function seasonStatus(team, standings, bracket) {
  var series = bracket ? teamSeries(team, bracket) : [];
  if (series.length) {
    var cur = series[series.length - 1];
    if (cur.opp >= cur.needed) return ['PLAYOFFS', 'ELIMINATED'];
    if (cur.mine < cur.needed) return null;
    return cur.round >= PLAYOFF_LABELS.big.rounds.length ? ['STANLEY CUP', 'CHAMPIONS'] : ['NEXT ROUND', 'TBD'];
  }
  var row = standings && standings.standings.filter(function(s) { return s.teamAbbrev.default === team; })[0];
  // The standings mark teams that can't make the playoffs e, and ones that have x, y, z, or p.
  if (!row || !row.clinchIndicator) return null;
  return ['PLAYOFFS', row.clinchIndicator === 'e' ? 'ELIMINATED' : 'CLINCHED'];
}

// The stat bubbles during the playoffs, from the season's bracket: the latest series'
// round and standing, the game number in it, the playoff record, and the wins left
// to win the Cup. Null if the team isn't in the bracket.
function buildPlayoffFields(team, bracket, picked) {
  var series = teamSeries(team, bracket);
  if (!series.length) return null;
  var won = 0, lost = 0, toCup = 0, cur = series[series.length - 1];
  series.forEach(function(s) {
    won += s.mine;
    lost += s.opp;
  });
  var labels = bigScreen() ? PLAYOFF_LABELS.big : PLAYOFF_LABELS.small;
  // Every round takes the same number of wins.
  toCup = labels.rounds.length * cur.needed - won;
  var standing = cur.mine >= cur.needed ? 'WON' : cur.opp >= cur.needed ? 'LOST' :
                 cur.mine > cur.opp ? 'LEAD' : cur.mine < cur.opp ? 'DOWN' : 'TIED';
  // The game on now or next in the series, if it's scheduled.
  var game = picked.live || picked.next;
  var number = game && game.gameType === 3 && game.seriesStatus && game.seriesStatus.gameNumberOfSeries;
  var msg = {};
  msg[keys.RecordLabel] = labels.rounds[cur.round - 1] || 'ROUND ' + cur.round;
  msg[keys.Record] = standing + ' ' + cur.mine + '-' + cur.opp;
  msg[keys.PointsLabel] = labels.game;
  msg[keys.Points] = standing === 'WON' || standing === 'LOST' || !number ? '-' : String(number);
  msg[keys.DivName] = labels.record;
  msg[keys.DivRank] = won + '-' + lost;
  msg[keys.LeagueLabel] = toCup === 0 ? 'CUP' : 'TO CUP';
  msg[keys.LeagueRank] = toCup === 0 ? labels.champs : standing === 'LOST' ? 'OUT' : String(toCup);
  return msg;
}

// How many goals the team (mine) and its opponent (opp) scored in this game since
// the last check. The first look at a game only records its score, so joining
// mid-game doesn't count.
function goalsScored(team, game) {
  var none = { mine: 0, opp: 0, score: 0 };
  if (!game) return none;
  var home = game.homeTeam.abbrev === team;
  var mine = (home ? game.homeTeam : game.awayTeam).score || 0;
  var opp = (home ? game.awayTeam : game.homeTeam).score || 0;
  var last = null;
  try { last = JSON.parse(localStorage.getItem('lastScore')); } catch (e) {}
  localStorage.setItem('lastScore', JSON.stringify({ id: game.id, score: mine, opp: opp }));
  if (!last || last.id !== game.id) return none;
  return {
    mine: Math.max(mine - last.score, 0),
    score: mine,
    // Scores saved before the opponent's was tracked don't have it.
    opp: last.opp === undefined ? 0 : Math.max(opp - last.opp, 0)
  };
}

// Which goals to buzz for: 'off', 'mine', or 'both'.
function goalVibe() {
  var mode = localStorage.getItem('goalVibe');
  if (mode) return mode;
  // Before the opponent option, this was an on/off setting for the team's goals.
  return localStorage.getItem('vibeOnGoal') === '1' ? 'mine' : 'off';
}

function abbrevOf(team) {
  return typeof team === 'string' ? team : team && team['default'];
}

// The parts of one goal from the scoreboard's goal list, for a notification or banner.
function goalParts(game, goal) {
  var tags = [];
  if (goal.strength === 'pp') tags.push('PP');
  if (goal.strength === 'sh') tags.push('SH');
  // Including goals awarded because the net was empty when a scoring chance was fouled.
  if (/empty-net$/.test(goal.goalModifier || '')) tags.push('EN');
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

// The team's goal that brought its score to score, or null if the scoreboard's goal
// list doesn't have it. The score can update before the goal list does.
function teamGoal(team, game, score) {
  var home = game.homeTeam.abbrev === team;
  return (game.goals || []).filter(function(g) {
    return abbrevOf(g.teamAbbrev) === team && (home ? g.homeScore : g.awayScore) === score;
  })[0] || null;
}

// Adds the banner fields for the team's goal that brought its score to score to
// msg. Returns false if the goal isn't in the game's goal list yet.
function addGoalBanner(team, game, score, msg) {
  var goal = teamGoal(team, game, score);
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

// Sends the banner for the team's goal that brought its score to score once the
// scoreboard lists it, checking again a few times, unless the team scores again first.
function sendGoalBanner(team, game, score, tries) {
  setTimeout(function() {
    getScoreboardGame(game, function(found) {
      var last = null;
      try { last = JSON.parse(localStorage.getItem('lastScore')); } catch (e) {}
      if (last && last.id === game.id && last.score !== score) return;
      var banner = {};
      if (found && addGoalBanner(team, found, score, banner)) {
        sendToWatch(banner);
      } else if (tries > 1) {
        sendGoalBanner(team, game, score, tries - 1);
      }
    });
  }, LIVE_POLL_MS);
}

// Whether to show the goal banner when the team scores.
function goalBanner() {
  var mode = localStorage.getItem('goalAlert');
  // Phone notifications were an option too; those who used them get the banner.
  if (mode) return mode !== 'off';
  // Before the banner, this was an on/off notification setting.
  return localStorage.getItem('goalNotify') === '1';
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
// should buzz for to msg; a goal banner not ready yet is sent later. liveScore is the
// game's scoreboard entry, if fetched. Returns true if anything happened.
function gameEvents(team, picked, liveScore, msg) {
  // Include the just-finished game so a game-ending goal still counts.
  var game = picked.live || picked.recent;
  var goals = goalsScored(team, liveScore || game);
  var scored = goals.mine;
  var vibe = goalVibe();
  if (scored && vibe !== 'off') {
    msg[keys.GoalScored] = GOAL_MINE;
  } else if (goals.opp && vibe === 'both') {
    msg[keys.GoalScored] = GOAL_OPP;
  }
  var banner = goalBanner();
  if (scored && banner && !(liveScore && addGoalBanner(team, liveScore, goals.score, msg))) {
    sendGoalBanner(team, game, goals.score, GOAL_BANNER_TRIES);
  }
  var rescored = !scored && banner && updateGoalBanner(liveScore || game, msg);
  var buzz = stageBuzz(picked, liveScore);
  if ((buzz === BUZZ_PERIOD && localStorage.getItem('vibeOnPeriod') === '1') ||
      (buzz === BUZZ_FINAL && localStorage.getItem('vibeOnFinal') === '1')) {
    msg[keys.GameBuzz] = buzz;
  }
  return scored > 0 || goals.opp > 0 || rescored || buzz !== 0;
}

// The live game being polled between regular updates, if any.
var livePoll = null;

function stopLivePoll() {
  if (livePoll) clearTimeout(livePoll.timer);
  livePoll = null;
}

// How long until the next scoreboard check: less often through most of an
// intermission, since nothing happens until the next period starts.
function pollDelay(found) {
  var clock = found && isLive(found.gameState) && found.clock;
  if (clock && clock.inIntermission && clock.secondsRemaining > INTERMISSION_END_SECS) {
    return Math.min(INTERMISSION_POLL_MS, (clock.secondsRemaining - INTERMISSION_END_SECS) * 1000);
  }
  return LIVE_POLL_MS;
}

// Polls the scoreboard for a live or about-to-start game and messages the watch only
// when there's puck drop, a goal, a period starting or ending, or the final horn. Once
// the game ends, does a full update.
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
          msg[keys.RefreshMins] = refreshMinutes(picked, found);
          sendToWatch(msg);
        }
      }
      if (over) {
        stopLivePoll();
        update();
      } else {
        poll.timer = setTimeout(tick, pollDelay(found));
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
  msg[keys.TeamAbbrev] = team;
  msg[keys.VibeOnDisconnect] = localStorage.getItem('vibeOnDisconnect') === '1' ? 1 : 0;
  var scheme = teamScheme(team);
  colors.applyScheme(msg, scheme, false);

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
    var season = playoffSeason(schedule);
    if (!season) {
      showGame(null);
      return;
    }
    getJSON(API + '/playoff-series/carousel/' + season + '/', function(err, data) {
      if (err) console.log(err.message);
      showGame(err ? null : data);
    });
  }
  // Adds the game, and the playoff stats from bracket if given, and sends it all.
  function showGame(bracket) {
    var picked = pickGames(schedule);
    var playoffs = bracket && buildPlayoffFields(team, bracket, picked);
    for (var p in playoffs) msg[p] = playoffs[p];
    var awayColors = localStorage.getItem('awayColors') !== '0';
    colors.applyScheme(msg, scheme, awayColors && awayToday(team, schedule));
    function finish(liveScore) {
      msg[keys.RefreshMins] = refreshMinutes(picked, liveScore);
      var gm = buildGameFields(team, picked, liveScore);
      // With no game to show, say where the season stands instead.
      var status = gm[keys.GameState] === STATE_NONE && seasonStatus(team, standings, bracket);
      if (status) {
        gm[keys.GameLine1] = status[0];
        gm[keys.GameLine2] = status[1];
      }
      for (var k in gm) msg[k] = gm[k];
      gameEvents(team, picked, liveScore, msg);
      sendToWatch(msg);
    }
    var game = picked.live || (nearStart(picked.next) && picked.next);
    if (!game) {
      stopLivePoll();
      finish(null);
      return;
    }
    startLivePoll(team, game);
    // The schedule lacks the period clock and lags at puck drop, so check the
    // daily scoreboard too.
    getScoreboardGame(game, function(found) {
      if (!picked.live && found && isLive(found.gameState)) picked = { live: found };
      finish(picked.live ? found : null);
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
  Object.keys(teams).forEach(function(abbr) {
    if (teams[abbr].classics) localStorage.setItem('classic' + abbr, settings[keys['ConfigClassic' + abbr]] || 'current');
  });
  var vibe = settings[keys.ConfigVibeOnGoal];
  localStorage.setItem('goalVibe', vibe === 'mine' || vibe === 'both' ? vibe : 'off');
  localStorage.setItem('goalAlert', settings[keys.ConfigGoalBanner] ? 'banner' : 'off');
  localStorage.setItem('bannerSecs', String(parseInt(settings[keys.ConfigBannerSecs], 10) || GOAL_BANNER_SECS));
  localStorage.setItem('vibeOnPeriod', settings[keys.ConfigVibeOnPeriod] ? '1' : '0');
  localStorage.setItem('vibeOnFinal', settings[keys.ConfigVibeOnFinal] ? '1' : '0');
  localStorage.setItem('vibeOnDisconnect', settings[keys.VibeOnDisconnect] ? '1' : '0');
  update();
});
