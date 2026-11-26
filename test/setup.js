// Lets modules under test require('message_keys'), which only exists inside the
// Pebble build, by pointing it at the keys the last `pebble build` generated.
var Module = require('module');
var path = require('path');

var KEYS = path.join(__dirname, '..', 'build', 'js', 'message_keys.json');
var resolve = Module._resolveFilename;
Module._resolveFilename = function(request) {
  if (request === 'message_keys') return KEYS;
  return resolve.apply(this, arguments);
};
