// The message that tells the watch what to show for the shown team: its name and
// colors, its stats or playoff standing, the game, and how soon to ask again. Builds
// it from what the phone has fetched; sends nothing.

var teams = require('./teams');
var colors = require('./colors');
var keys = require('message_keys');
var schedule = require('./schedule');
var gameEvents = require('./game-events');
var nextOrDelayed = schedule.nextOrDelayed;
var periodLabel = gameEvents.periodLabel, scoreLine = gameEvents.scoreLine, ordinal = gameEvents.ordinal;

// What the game bubble shows, as the watch knows it.
var STATE_NONE = 0, STATE_NEXT = 1, STATE_LIVE = 2, STATE_FINAL = 3;
// How often to ask again without a schedule to go by.
var NO_SCHEDULE_MINS = 10;

// The team's colors: its current ones, or the classic scheme picked in settings.
function teamScheme(team, settings) {
  var info = teams[team];
  var id = settings.classics[team];
  var picked = (info.classics || []).filter(function(c) { return c.id === id; })[0];
  return picked || info;
}

// The game to show, from games, teamGames' pick: a live game, a suspended game, a
// recent final, or else the delayed or next game.
function buildGameFields(team, games, liveScore, settings) {
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
    if (liveScore && settings.showShots) {
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

function refreshMinutes(games, liveScore, now) {
  if (games.live) {
    var clock = liveScore && liveScore.clock;
    return clock && clock.inIntermission ? 5 : 1;
  }
  var upcoming = nextOrDelayed(games);
  if (upcoming) {
    var mins = (Date.parse(upcoming.startTimeUTC) - now) / 60000;
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

// The Pebble Time 2 has room for the longer labels.
var BIG_SCREENS = ['emery'];

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
function buildPlayoffFields(team, bracket, games, platform) {
  var series = teamSeries(team, bracket);
  if (!series.length) return null;
  var won = 0, lost = 0, toCup = 0, cur = series[series.length - 1];
  series.forEach(function(s) {
    won += s.mine;
    lost += s.opp;
  });
  var labels = BIG_SCREENS.indexOf(platform) >= 0 ? PLAYOFF_LABELS.big : PLAYOFF_LABELS.small;
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

function copyInto(msg, fields) {
  for (var k in fields) msg[k] = fields[k];
}

// The game bubble's fields for team's game from games, with liveScore its scoreboard
// entry if it's live and fetched, and the refresh interval for it alone.
function gameMessage(team, games, liveScore, settings, now) {
  var msg = buildGameFields(team, games, liveScore, settings);
  msg[keys.RefreshMins] = refreshMinutes(games, liveScore, now);
  return msg;
}

// Everything the watch shows for the shown team, from:
//   team: its abbreviation.
//   games: teamGames' pick from its schedule, or null without a schedule, which keeps
//     the watch's game as it is.
//   scoreboard: the scoreboard entry for its live or about-to-start game, if fetched.
//     It can show a game live before the schedule does.
//   standings, bracket: the NHL's, either one null if not fetched or not needed.
//   settings: from settings.read.
//   platform: the watch model, such as 'emery'.
//   others: the other followed teams, { team, games }, so one of their games starting
//     soon gets the same quick refreshes.
//   awayToday: whether the team plays an away game today.
//   now: the time.
function faceMessage(input) {
  var team = input.team, games = input.games, settings = input.settings;
  var scheme = teamScheme(team, settings);
  var msg = {};
  msg[keys.TeamName] = teams[team].name.toUpperCase();
  msg[keys.TeamAbbrev] = team;
  msg[keys.VibeOnDisconnect] = settings.vibeOnDisconnect ? 1 : 0;
  if (input.standings) copyInto(msg, buildStandingsFields(team, input.standings));
  if (!games) {
    colors.applyScheme(msg, scheme, false);
    msg[keys.RefreshMins] = NO_SCHEDULE_MINS;
    return msg;
  }
  if (input.bracket) copyInto(msg, buildPlayoffFields(team, input.bracket, games, input.platform));
  colors.applyScheme(msg, scheme, settings.awayColors && input.awayToday);

  var shown = schedule.withScoreboard(games, input.scoreboard);
  var liveScore = shown.live ? input.scoreboard || null : null;
  var gm = gameMessage(team, shown, liveScore, settings, input.now);
  gm[keys.RefreshMins] = (input.others || []).reduce(function(mins, other) {
    return Math.min(mins, refreshMinutes(other.games, null, input.now));
  }, gm[keys.RefreshMins]);
  // With no game to show, say where the season stands instead.
  var status = gm[keys.GameState] === STATE_NONE && seasonStatus(team, input.standings, input.bracket);
  if (status) {
    gm[keys.GameLine1] = status[0];
    gm[keys.GameLine2] = status[1];
  }
  copyInto(msg, gm);
  return msg;
}

module.exports = { faceMessage: faceMessage, gameMessage: gameMessage };
