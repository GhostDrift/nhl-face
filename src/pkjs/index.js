var Clay = require('pebble-clay');
var clayConfig = require('./config');
var chooseTeam = require('./followed').chooseTeam;
var settings = require('./settings');
var timeline = require('./timeline');
var pins = timeline.createPins({ timeline: timeline.rebbleTimeline(), localStorage: localStorage });
var teamGames = require('./schedule').teamGames;
var nextOrDelayed = require('./schedule').nextOrDelayed;
var awayToday = require('./schedule').awayToday;
var getPlayoffSeasonId = require('./schedule').getPlayoffSeasonId;
var isLive = require('./schedule').isLive;
var isOver = require('./schedule').isOver;
var isCalledOff = require('./schedule').isCalledOff;
var gameEvents = require('./game-events');
var faceMessage = require('./face-message').faceMessage;
var gameMessage = require('./face-message').gameMessage;
var onlyGame = require('./schedule').onlyGame;
var withScoreboard = require('./schedule').withScoreboard;
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

// True when the game is about to start, or should have and isn't live yet.
function nearStart(game) {
  return !!game && Date.parse(game.startTimeUTC) - Date.now() < PUCK_DROP_WATCH_MS;
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
          var gm = gameMessage(team, games, found, getSettings(), Date.now());
          for (var k in gm) msg[k] = gm[k];
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

// Every team's W-L-OTL record from the standings, by abbreviation. Empty without them.
function teamRecords(standings) {
  var records = {};
  (standings ? standings.standings : []).forEach(function(s) {
    records[s.teamAbbrev.default] = s.wins + '-' + s.losses + '-' + s.otLosses;
  });
  return records;
}

// The watch model, such as 'emery'.
function platform() {
  var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
  return info ? info.platform : null;
}

// Sends the watch everything for team. Without a schedule the game stays as it is.
// others are the other followed teams, as chooseTeam takes them, so one of their games
// starting soon gets the same quick updates as the team's own.
function showTeam(team, schedule, standings, others) {
  var input = { team: team, games: null, scoreboard: null, standings: standings, bracket: null,
                settings: getSettings(), platform: platform(), others: others, awayToday: false, now: Date.now() };
  if (!schedule) {
    sendToWatch(faceMessage(input));
    return;
  }

  // Adds the game, and the playoff stats from bracket if given, and sends it all.
  function showGame(bracket) {
    input.bracket = bracket;
    input.now = Date.now();
    input.games = teamGames(schedule, input.now);
    input.awayToday = awayToday(team, schedule, input.now);
    function finish(scoreboard) {
      input.scoreboard = scoreboard;
      var msg = faceMessage(input);
      var shown = withScoreboard(input.games, scoreboard);
      checkGame(team, shown, shown.live ? scoreboard : null, msg);
      sendToWatch(msg);
    }
    var upcoming = nextOrDelayed(input.games);
    var game = input.games.live || (nearStart(upcoming) && upcoming);
    if (!game) {
      stopLivePoll();
      finish(null);
      return;
    }
    startLivePoll(team, game);
    // The schedule lacks the period clock and lags at puck drop, so check the
    // daily scoreboard too.
    getScoreboardGame(game, finish);
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
    pins.sync(schedules, teamRecords(standings), getSettings().pinsOn, Date.now());
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
