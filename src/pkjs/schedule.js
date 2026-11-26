// Reading a team's season schedule, from the NHL's club-schedule-season feed, in the
// terms GLOSSARY.md defines: live game, suspended game, recent final, delayed game and
// next game. now is passed in so tests can fix the time.

// The face shows a recent final, or waits on a delayed game, until this long after
// puck drop.
var FINAL_WINDOW_MS = 6 * 60 * 60 * 1000;
// Postponed, suspended and cancelled: called-off games, by schedule state.
var CALLED_OFF = ['PPD', 'SUSP', 'CNCL'];

function startOf(game) {
  return Date.parse(game.startTimeUTC);
}

// Whether a game, from the schedule or the scoreboard, is being played.
function isLive(game) {
  return game.gameState === 'LIVE' || game.gameState === 'CRIT';
}

// Whether a game, from the schedule or the scoreboard, has been played through.
function isOver(game) {
  return game.gameState === 'FINAL' || game.gameState === 'OFF';
}

function isCalledOff(game) {
  return CALLED_OFF.indexOf(game.gameScheduleState) >= 0;
}

// The team's games that matter now, from schedule, its season schedule in order. Each
// is a game or null:
//   live: being played.
//   suspended: suspended within 6 hours of its puck drop.
//   recentFinal: finished within 6 hours of its puck drop.
//   delayed: past its scheduled puck drop within the last 6 hours, but not started.
//   next: the first game whose scheduled puck drop is still ahead.
// Postponed and cancelled games are never any of these.
function teamGames(schedule, now) {
  var games = { live: null, suspended: null, recentFinal: null, delayed: null, next: null };
  schedule.games.forEach(function(g) {
    var start = startOf(g);
    var recent = now - start < FINAL_WINDOW_MS;
    if (g.gameScheduleState === 'SUSP') {
      if (recent && start <= now) games.suspended = g;
    } else if (isCalledOff(g)) {
      return;
    } else if (isLive(g)) {
      games.live = g;
    } else if (isOver(g)) {
      if (recent) games.recentFinal = g;
    } else if (start > now) {
      if (!games.next) games.next = g;
    } else if (recent && !games.delayed) {
      games.delayed = g;
    }
  });
  return games;
}

// The game the face shows before puck drop, from teamGames: the delayed game, if
// there is one, else the next game. Null if neither.
function nextOrDelayed(games) {
  return games.delayed || games.next;
}

// A teamGames pick with only game, as kind, such as 'live'.
function onlyGame(kind, game) {
  var games = { live: null, suspended: null, recentFinal: null, delayed: null, next: null };
  games[kind] = game;
  return games;
}

// games, from teamGames, with scoreboard's game as the live game when the scoreboard
// shows it live before the schedule does, as it can at puck drop.
function withScoreboard(games, scoreboard) {
  return !games.live && scoreboard && isLive(scoreboard) ? onlyGame('live', scoreboard) : games;
}

// True when the team plays an away game today, by the phone's clock. Postponed and
// cancelled games aren't played, so don't count.
function awayToday(team, schedule, now) {
  var today = new Date(now).toDateString();
  return schedule.games.some(function(g) {
    return g.gameScheduleState !== 'PPD' && g.gameScheduleState !== 'CNCL' && g.awayTeam.abbrev === team &&
           new Date(startOf(g)).toDateString() === today;
  });
}

// The NHL id of the season whose playoffs the team is in, such as 20252026, once its
// regular season is over: its schedule has playoff games and no regular season games
// left to play. Null otherwise.
function getPlayoffSeasonId(schedule) {
  var playoff = null;
  for (var i = 0; i < schedule.games.length; i++) {
    var g = schedule.games[i];
    if (g.gameType === 2 && !isOver(g) && g.gameScheduleState !== 'CNCL') return null;
    if (g.gameType === 3) playoff = g;
  }
  return playoff && playoff.season;
}

module.exports = {
  teamGames: teamGames,
  nextOrDelayed: nextOrDelayed,
  onlyGame: onlyGame,
  withScoreboard: withScoreboard,
  awayToday: awayToday,
  getPlayoffSeasonId: getPlayoffSeasonId,
  isLive: isLive,
  isOver: isOver,
  isCalledOff: isCalledOff
};
