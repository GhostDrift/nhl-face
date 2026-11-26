# nhl-face

A Pebble watch face that shows the user's followed NHL teams' games, and pins those games to the watch's timeline.

## Language

### Teams

**Followed team**:
One of the up to three teams the user picked in settings. Every followed team gets pins, whether or not the face is showing it.
_Avoid_: Picked team, my team, favorite

**Shown team**:
The one followed team whose game is on the face right now.
_Avoid_: Visible team, current team

### Games

**Next game**:
A followed team's first game whose scheduled puck drop is still ahead and that hasn't been postponed, suspended or cancelled. A game delayed past its scheduled puck drop is no longer the next game, even before it starts.
_Avoid_: Upcoming game, future game

**Postponed game**:
A game the NHL has called off before it started, to be played on a date set later.
_Avoid_: Delayed game, rescheduled game

**Suspended game**:
A game that started and was stopped partway, to be finished later.
_Avoid_: Paused game, interrupted game

**Cancelled game**:
A game the NHL has called off for good.
_Avoid_: Postponed game, removed game

### Timeline

**Pin**:
An entry this app puts on the user's Pebble timeline for one game.
_Avoid_: Timeline item, event

**Upcoming pin**:
A pin at a game's puck drop, placed before the game starts. It lasts until that game's final pin replaces it.
_Avoid_: Next-game pin, pre-game pin, schedule pin

**Final pin**:
A pin at the end of a finished game showing its final score. It replaces that game's upcoming pin.
_Avoid_: Result pin, score pin
