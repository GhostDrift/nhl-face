// What the watch should buzz for and show as a game goes on: goals, the goal banner,
// periods starting and ending, and the final horn. Each check compares a game with
// lastSeen, what was seen at the last check, so only changes count, and joining a game
// partway doesn't buzz for what already happened.
//
// lastSeen is null before the first check, then what check returns:
//   score: { id, score, opp }, the game and both teams' scores, mine first.
//   stage: { id, stage }, the game and how far along it is, as STAGE_* or a period.
//   banner: { id, score, until }, the goal banner showing, its score line, and when it
//     goes away.
// The caller keeps lastSeen between checks.

var nextOrDelayed = require('./schedule').nextOrDelayed;

// Game stages, in order: before puck drop, then each period in play (odd) and the
// intermission after it (even), then final.
var STAGE_PREGAME = 0, STAGE_FINAL = 99;

function ordinal(n) {
  return n + (['th', 'st', 'nd', 'rd'][n] || 'th');
}

// A period as the watch shows it: 1st, 2nd, 3rd, OT, 2OT, SO.
function periodLabel(desc) {
  if (!desc) return '';
  if (desc.periodType === 'SO') return 'SO';
  if (desc.periodType === 'OT') {
    var ot = desc.number - (desc.maxRegulationPeriods || 3);
    return ot > 1 ? ot + 'OT' : 'OT';
  }
  return ordinal(desc.number);
}

function scoreLine(game, away, home) {
  if (away === undefined) away = game.awayTeam.score || 0;
  if (home === undefined) home = game.homeTeam.score || 0;
  return game.awayTeam.abbrev + ' ' + away + '  @  ' + game.homeTeam.abbrev + ' ' + home;
}

function abbrevOf(team) {
  return typeof team === 'string' ? team : team && team['default'];
}

function copy(lastSeen) {
  var seen = { score: null, stage: null, banner: null };
  for (var k in lastSeen || {}) seen[k] = lastSeen[k];
  return seen;
}

// How many goals the team (mine) and its opponent (opp) scored in game since seen,
// and the team's score now. Records the scores in seen.
function goalsScored(seen, team, game) {
  var none = { mine: 0, opp: 0, score: 0 };
  if (!game) return none;
  var home = game.homeTeam.abbrev === team;
  var mine = (home ? game.homeTeam : game.awayTeam).score || 0;
  var opp = (home ? game.awayTeam : game.homeTeam).score || 0;
  var last = seen.score;
  seen.score = { id: game.id, score: mine, opp: opp };
  if (!last || last.id !== game.id) return none;
  return { mine: Math.max(mine - last.score, 0), opp: Math.max(opp - last.opp, 0), score: mine };
}

// The team's goal that brought its score to score, from the scoreboard's goal list,
// or null if the list doesn't have it yet. The score can update before the list does.
function teamGoal(team, scoreboard, score) {
  var home = scoreboard.homeTeam.abbrev === team;
  return (scoreboard.goals || []).filter(function(g) {
    return abbrevOf(g.teamAbbrev) === team && (home ? g.homeScore : g.awayScore) === score;
  })[0] || null;
}

// The banner for the team's goal that brought its score to score, recorded in seen,
// or null if the scoreboard doesn't list the goal yet.
function goalBanner(seen, team, scoreboard, score, settings, now) {
  var goal = teamGoal(team, scoreboard, score);
  if (!goal) return null;
  var tags = [];
  if (goal.strength === 'pp') tags.push('PP');
  if (goal.strength === 'sh') tags.push('SH');
  // Including goals awarded because the net was empty when a scoring chance was fouled.
  if (/empty-net$/.test(goal.goalModifier || '')) tags.push('EN');
  var assists = (goal.assists || []).map(function(a) { return a.name['default']; });
  var banner = {
    scorer: goal.name['default'],
    assists: assists.length ? assists.join(', ') : 'Unassisted',
    time: periodLabel(goal.periodDescriptor) + ' ' + goal.timeInPeriod + (tags.length ? ' ' + tags.join(' ') : ''),
    score: scoreLine(scoreboard, goal.awayScore, goal.homeScore),
    secs: settings.bannerSecs
  };
  seen.banner = { id: scoreboard.id, score: banner.score, until: now + banner.secs * 1000 };
  return banner;
}

// The game's score line if it changed while its goal banner is up, such as the other
// team scoring right after, recorded in seen. Else null.
function bannerRescore(seen, game, now) {
  var banner = seen.banner;
  if (!game || !banner || banner.id !== game.id || now > banner.until) return null;
  var score = scoreLine(game);
  if (score === banner.score) return null;
  seen.banner = { id: banner.id, score: score, until: banner.until };
  return score;
}

// The tracked game's current stage, or null when it can't be told this check. A
// suspended game has none, so it never counts as ending.
function gameStage(games, scoreboard) {
  if (games.live) {
    if (!scoreboard || !scoreboard.periodDescriptor) return null;
    var stage = scoreboard.periodDescriptor.number * 2 - 1;
    if (scoreboard.clock && scoreboard.clock.inIntermission) stage += 1;
    return { id: games.live.id, stage: stage };
  }
  if (games.suspended) return null;
  if (games.recentFinal) return { id: games.recentFinal.id, stage: STAGE_FINAL };
  var upcoming = nextOrDelayed(games);
  if (upcoming) return { id: upcoming.id, stage: STAGE_PREGAME };
  return null;
}

// 'period' or 'final' when a period started or ended, or the game ended, since seen,
// else null. Records the stage in seen. Only a final seen coming counts, so a game
// first seen over doesn't buzz.
function stageChange(seen, games, scoreboard) {
  var cur = gameStage(games, scoreboard);
  if (!cur) return null;
  var last = seen.stage;
  seen.stage = cur;
  if (!last || last.id !== cur.id || cur.stage <= last.stage) return null;
  if (cur.stage === STAGE_FINAL) return last.stage > STAGE_PREGAME ? 'final' : null;
  return 'period';
}

// Checks team's game, from games (teamGames' pick), against lastSeen. scoreboard is
// the game's scoreboard entry, with its goal list, if fetched. Returns:
//   goal: 'mine' or 'opp' for a goal to buzz for, by settings.goalVibe, else null.
//   stage: 'period' or 'final' to buzz for, by settings.vibeOnPeriod and vibeOnFinal,
//     else null.
//   banner: with settings.goalBanner, the new goal's banner, { scorer, assists, time,
//     score, secs }, or { score } for a banner already showing whose score changed.
//     Else null.
//   bannerWaiting: the team's score whose goal the scoreboard doesn't list yet, to try
//     again with bannerFor, else null.
//   changed: whether anything happened at all, buzz or not, so the watch needs the
//     game again.
//   lastSeen: to keep for the next check.
function check(lastSeen, team, games, scoreboard, settings, now) {
  var seen = copy(lastSeen);
  // Include the just-finished game so a game-ending goal still counts.
  var game = games.live || games.recentFinal;
  var goals = goalsScored(seen, team, scoreboard || game);
  var result = { goal: null, stage: null, banner: null, bannerWaiting: null, changed: false, lastSeen: seen };
  if (goals.mine && settings.goalVibe !== 'off') result.goal = 'mine';
  else if (goals.opp && settings.goalVibe === 'both') result.goal = 'opp';
  var rescore = null;
  if (settings.goalBanner && goals.mine) {
    result.banner = scoreboard && goalBanner(seen, team, scoreboard, goals.score, settings, now);
    if (!result.banner) {
      result.banner = null;
      result.bannerWaiting = goals.score;
    }
  } else if (settings.goalBanner) {
    rescore = bannerRescore(seen, scoreboard || game, now);
    if (rescore) result.banner = { score: rescore };
  }
  var stage = stageChange(seen, games, scoreboard);
  if ((stage === 'period' && settings.vibeOnPeriod) || (stage === 'final' && settings.vibeOnFinal)) {
    result.stage = stage;
  }
  result.changed = goals.mine > 0 || goals.opp > 0 || !!rescore || !!stage;
  return result;
}

// Another try at the banner check gave as bannerWaiting, for the team's goal that
// brought its score to score, now that scoreboard may list it. Returns:
//   banner: the goal's banner, as check gives it, or null if it isn't listed yet.
//   outdated: true if the team has scored again since, so this banner is no longer
//     wanted; stop trying.
//   lastSeen: to keep.
function bannerFor(lastSeen, team, gameId, scoreboard, score, settings, now) {
  var seen = copy(lastSeen);
  var last = seen.score;
  if (last && last.id === gameId && last.score !== score) {
    return { banner: null, outdated: true, lastSeen: seen };
  }
  var banner = scoreboard ? goalBanner(seen, team, scoreboard, score, settings, now) : null;
  return { banner: banner, outdated: false, lastSeen: seen };
}

module.exports = {
  check: check,
  bannerFor: bannerFor,
  periodLabel: periodLabel,
  scoreLine: scoreLine,
  ordinal: ordinal
};
