var Clay = require('pebble-clay');
var clayConfig = require('./config');
var teams = require('./teams');
var colors = require('./colors');
var chooseTeam = require('./followed').chooseTeam;
var settings = require('./settings');
var teamGames = require('./schedule').teamGames;
var nextOrDelayed = require('./schedule').nextOrDelayed;
var awayToday = require('./schedule').awayToday;
var getPlayoffSeasonId = require('./schedule').getPlayoffSeasonId;
var isLive = require('./schedule').isLive;
var isOver = require('./schedule').isOver;
var isCalledOff = require('./schedule').isCalledOff;
var gameEvents = require('./game-events');
var periodLabel = gameEvents.periodLabel, scoreLine = gameEvents.scoreLine, ordinal = gameEvents.ordinal;
var keys = require('message_keys');

// Runs in the settings page: shows only the picked teams' Classic colors options.
function clayCustom() {
  var clay = this;
  var pickers = ['ConfigTeam', 'ConfigTeam2', 'ConfigTeam3'];
  function sync() {
    var shown = pickers.map(function(key) {
      return 'ConfigClassic' + clay.getItemByMessageKey(key).get();
    });
    clay.getAllItems().forEach(function(item) {
      if (!/^ConfigClassic/.test(item.messageKey || '')) return;
      if (shown.indexOf(item.messageKey) >= 0) item.show(); else item.hide();
    });
  }
  clay.on(clay.EVENTS.AFTER_BUILD, function() {
    pickers.forEach(function(key) {
      clay.getItemByMessageKey(key).on('change', sync);
    });
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
// How many times to check for a goal that's in the score but not the goal list yet,
// LIVE_POLL_MS apart.
var GOAL_BANNER_TRIES = 9;
// How long a game that just ended keeps the face before another followed team's game.
var FINAL_HOLD_MS = 2 * 60 * 1000;

// Everything picked on the settings page.
function getSettings() {
  return settings.read(localStorage);
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
  var id = getSettings().classics[team];
  var picked = (info.classics || []).filter(function(c) { return c.id === id; })[0];
  return picked || info;
}

// The game to show, from games, teamGames' pick: a live game, a suspended game, a
// recent final, or else the delayed or next game.
function buildGameFields(team, games, liveScore) {
  var msg = {};
  var g;
  var upcoming = nextOrDelayed(games);
  if (games.live) {
    g = liveScore || games.live;
    var status = periodLabel(g.periodDescriptor);
    if (g.clock) {
      status += g.clock.inIntermission ? ' INT' : ' ' + g.clock.timeRemaining;
    }
    msg[keys.GameState] = STATE_LIVE;
    msg[keys.GameLine1] = 'LIVE  ' + status;
    msg[keys.GameLine2] = scoreLine(g);
    // Only the scoreboard has shots; without it, or with shots turned off in settings,
    // the watch keeps the record row.
    if (liveScore && getSettings().showShots) {
      msg[keys.GameAwayShots] = String(g.awayTeam.sog || 0);
      msg[keys.GameHomeShots] = String(g.homeTeam.sog || 0);
    }
  } else if (games.suspended) {
    msg[keys.GameState] = STATE_FINAL;
    msg[keys.GameLine1] = 'SUSPENDED';
    msg[keys.GameLine2] = scoreLine(games.suspended);
  } else if (games.recentFinal) {
    g = games.recentFinal;
    var last = g.gameOutcome && g.gameOutcome.lastPeriodType;
    msg[keys.GameState] = STATE_FINAL;
    msg[keys.GameLine1] = 'FINAL' + (last && last !== 'REG' ? '/' + last : '');
    msg[keys.GameLine2] = scoreLine(g);
  } else if (upcoming) {
    g = upcoming;
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

function refreshMinutes(games, liveScore) {
  if (games.live) {
    var clock = liveScore && liveScore.clock;
    return clock && clock.inIntermission ? 5 : 1;
  }
  var upcoming = nextOrDelayed(games);
  if (upcoming) {
    var mins = (Date.parse(upcoming.startTimeUTC) - Date.now()) / 60000;
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
function buildPlayoffFields(team, bracket, games) {
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
  var game = games.live || nextOrDelayed(games);
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

// What was seen at the last game-events check, kept between checks.
function loadLastSeen() {
  try { return JSON.parse(localStorage.getItem('lastSeen')); } catch (e) { return null; }
}

function saveLastSeen(lastSeen) {
  localStorage.setItem('lastSeen', JSON.stringify(lastSeen));
}

// Adds what game-events found, from check or bannerFor, to msg for the watch.
function addEvents(msg, events) {
  if (events.goal) msg[keys.GoalScored] = events.goal === 'mine' ? GOAL_MINE : GOAL_OPP;
  var banner = events.banner;
  if (banner && banner.scorer !== undefined) {
    msg[keys.GoalScorer] = banner.scorer;
    msg[keys.GoalAssists] = banner.assists;
    msg[keys.GoalTime] = banner.time;
    msg[keys.GoalBannerSecs] = banner.secs;
  }
  if (banner) msg[keys.GoalScore] = banner.score;
  if (events.stage) msg[keys.GameBuzz] = events.stage === 'period' ? BUZZ_PERIOD : BUZZ_FINAL;
}

// Sends the banner for the team's goal that brought its score to score once the
// scoreboard lists it, checking again a few times, unless the team scores again first.
function sendGoalBanner(team, game, score, tries) {
  setTimeout(function() {
    getScoreboardGame(game, function(found) {
      var result = gameEvents.bannerFor(loadLastSeen(), team, game.id, found, score, getSettings(), Date.now());
      if (result.outdated) return;
      if (result.banner) {
        saveLastSeen(result.lastSeen);
        var msg = {};
        addEvents(msg, result);
        sendToWatch(msg);
      } else if (tries > 1) {
        sendGoalBanner(team, game, score, tries - 1);
      }
    });
  }, LIVE_POLL_MS);
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

// Runs the game-events check for team's game, from games, and adds whatever the watch
// should buzz for or show to msg; a goal banner not ready yet is sent later. liveScore
// is the game's scoreboard entry, if fetched. Returns true if anything happened.
function checkGame(team, games, liveScore, msg) {
  var events = gameEvents.check(loadLastSeen(), team, games, liveScore, getSettings(), Date.now());
  saveLastSeen(events.lastSeen);
  addEvents(msg, events);
  if (events.bannerWaiting !== null) {
    sendGoalBanner(team, games.live || games.recentFinal, events.bannerWaiting, GOAL_BANNER_TRIES);
  }
  return events.changed;
}

// A teamGames pick with only game, as kind, such as 'live'.
function onlyGame(kind, game) {
  var games = { live: null, suspended: null, recentFinal: null, delayed: null, next: null };
  games[kind] = game;
  return games;
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
  var clock = found && isLive(found) && found.clock;
  if (clock && clock.inIntermission && clock.secondsRemaining > INTERMISSION_END_SECS) {
    return Math.min(INTERMISSION_POLL_MS, (clock.secondsRemaining - INTERMISSION_END_SECS) * 1000);
  }
  return LIVE_POLL_MS;
}

// Keeps the just-ended game on the face for a little, then updates to move on.
function holdFinal(game) {
  localStorage.setItem('finalHold', JSON.stringify({ id: game.id, until: Date.now() + FINAL_HOLD_MS }));
  setTimeout(update, FINAL_HOLD_MS + 1000);
}

// The id of the game whose final is being held, if any.
function heldGame() {
  var hold = null;
  try { hold = JSON.parse(localStorage.getItem('finalHold')); } catch (e) {}
  return hold && Date.now() < hold.until ? hold.id : null;
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
      // A suspended game is over for now, though not finished, so it ends the polling
      // without any events.
      var off = found && isCalledOff(found);
      var over = found && (isOver(found) || off);
      if (found && !off && (isLive(found) || over)) {
        var games = onlyGame(over ? 'recentFinal' : 'live', found);
        var msg = {};
        if (checkGame(team, games, found, msg)) {
          var gm = buildGameFields(team, games, found);
          for (var k in gm) msg[k] = gm[k];
          msg[keys.RefreshMins] = refreshMinutes(games, found);
          sendToWatch(msg);
        }
      }
      if (over) {
        stopLivePoll();
        holdFinal(found);
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

// Sends the watch everything for team. Without a schedule the game stays as it is.
// others are the other followed teams, as chooseTeam takes them, so one of their games
// starting soon gets the same quick updates as the team's own.
function showTeam(team, schedule, standings, others) {
  var info = teams[team];
  var msg = {};
  msg[keys.TeamName] = info.name.toUpperCase();
  msg[keys.TeamAbbrev] = team;
  msg[keys.VibeOnDisconnect] = getSettings().vibeOnDisconnect ? 1 : 0;
  var scheme = teamScheme(team);
  colors.applyScheme(msg, scheme, false);
  if (standings) {
    var s = buildStandingsFields(team, standings);
    for (var k in s) msg[k] = s[k];
  }
  if (!schedule) {
    msg[keys.RefreshMins] = 10;
    sendToWatch(msg);
    return;
  }

  // Adds the game, and the playoff stats from bracket if given, and sends it all.
  function showGame(bracket) {
    var games = teamGames(schedule, Date.now());
    var playoffs = bracket && buildPlayoffFields(team, bracket, games);
    for (var p in playoffs) msg[p] = playoffs[p];
    colors.applyScheme(msg, scheme, getSettings().awayColors && awayToday(team, schedule, Date.now()));
    function finish(liveScore) {
      msg[keys.RefreshMins] = others.reduce(function(mins, other) {
        return Math.min(mins, refreshMinutes(other.games, null));
      }, refreshMinutes(games, liveScore));
      var gm = buildGameFields(team, games, liveScore);
      // With no game to show, say where the season stands instead.
      var status = gm[keys.GameState] === STATE_NONE && seasonStatus(team, standings, bracket);
      if (status) {
        gm[keys.GameLine1] = status[0];
        gm[keys.GameLine2] = status[1];
      }
      for (var k in gm) msg[k] = gm[k];
      checkGame(team, games, liveScore, msg);
      sendToWatch(msg);
    }
    var upcoming = nextOrDelayed(games);
    var game = games.live || (nearStart(upcoming) && upcoming);
    if (!game) {
      stopLivePoll();
      finish(null);
      return;
    }
    startLivePoll(team, game);
    // The schedule lacks the period clock and lags at puck drop, so check the
    // daily scoreboard too.
    getScoreboardGame(game, function(found) {
      if (!games.live && found && isLive(found)) games = onlyGame('live', found);
      finish(games.live ? found : null);
    });
  }

  var season = getPlayoffSeasonId(schedule);
  if (!season) {
    showGame(null);
    return;
  }
  getJSON(API + '/playoff-series/carousel/' + season + '/', function(err, data) {
    if (err) console.log(err.message);
    showGame(err ? null : data);
  });
}

// Fetches every followed team's schedule, then shows the one chooseTeam picks. If any
// schedule is missing, stays on the team already showing rather than choosing without it.
function update() {
  var followed = getSettings().followedTeams;
  var standings = null, schedules = {};
  var pending = followed.length + 1;
  function done() {
    if (--pending > 0) return;
    var complete = followed.every(function(team) { return schedules[team]; });
    if (!complete) {
      var last = localStorage.getItem('shownTeam');
      showTeam(followed.indexOf(last) >= 0 ? last : followed[0], null, standings, []);
      return;
    }
    var entries = followed.map(function(team) {
      return { team: team, games: teamGames(schedules[team], Date.now()) };
    });
    var team = chooseTeam(entries, nearStart, heldGame());
    localStorage.setItem('shownTeam', team);
    showTeam(team, schedules[team], standings, entries.filter(function(e) { return e.team !== team; }));
  }

  getJSON(API + '/standings/now', function(err, data) {
    if (err) console.log(err.message); else standings = data;
    done();
  });
  followed.forEach(function(team) {
    getJSON(API + '/club-schedule-season/' + team + '/now', function(err, data) {
      if (err) console.log(err.message); else schedules[team] = data;
      done();
    });
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
  settings.saveFromConfig(localStorage, clay.getSettings(e.response));
  update();
});
