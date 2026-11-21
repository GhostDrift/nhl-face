// Choosing which of the followed teams the face shows.

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

// Picks from entries, in the user's team order, each { team, picked } with picked from
// pickGames. A just-ended game whose final is being held, heldId, comes first. Then a
// live game, the one that started first so an overlapping game waits its turn. Then a
// game about to start (nearStart says so), then the last game to finish, whose final
// stays up for a while, then the next game on the schedule. With nothing at all to
// show, team 1.
function chooseTeam(entries, nearStart, heldId) {
  var held = heldId && entries.filter(function(e) { return e.picked.recent && e.picked.recent.id === heldId; })[0];
  var shown = held ||
              byStart(entries, function(e) { return e.picked.live; }) ||
              byStart(entries, function(e) { return nearStart(e.picked.next) && e.picked.next; }) ||
              byStart(entries, function(e) { return e.picked.recent; }, true) ||
              byStart(entries, function(e) { return e.picked.next; }) ||
              entries[0];
  return shown.team;
}

module.exports = { chooseTeam: chooseTeam };
