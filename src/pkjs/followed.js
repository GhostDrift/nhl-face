// Choosing which of the followed teams the face shows.

var nextOrDelayed = require('./schedule').nextOrDelayed;

function startOf(game) {
  return Date.parse(game.startTimeUTC);
}

// The entry whose game, from gameOf, starts earliest, or with latest set, last. Ties
// go to the entry listed first, so team 1 wins a shared start time.
function byStart(entries, gameOf, latest) {
  var best = null;
  entries.forEach(function(e) {
    var game = gameOf(e);
    if (!game) return;
    var diff = best ? startOf(game) - startOf(gameOf(best)) : 0;
    if (!best || (latest ? diff > 0 : diff < 0)) best = e;
  });
  return best;
}

// A suspended game stays up like a recent final.
function ended(e) {
  return e.games.recentFinal || e.games.suspended;
}

// Picks from entries, in the user's team order, each { team, games } with games from
// teamGames. A just-ended game whose final is being held, heldId, comes first. Then a
// live game, the one that started first so an overlapping game waits its turn. Then a
// game about to start (nearStart says so), then the last game to end, whose final
// stays up for a while, then the delayed or next game. With nothing at all to show,
// team 1.
function chooseTeam(entries, nearStart, heldId) {
  var held = heldId && entries.filter(function(e) { return ended(e) && ended(e).id === heldId; })[0];
  var shown = held ||
              byStart(entries, function(e) { return e.games.live; }) ||
              byStart(entries, function(e) { var g = nextOrDelayed(e.games); return nearStart(g) && g; }) ||
              byStart(entries, ended, true) ||
              byStart(entries, function(e) { return nextOrDelayed(e.games); }) ||
              entries[0];
  return shown.team;
}

module.exports = { chooseTeam: chooseTeam };
