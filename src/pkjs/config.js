var teams = require('./teams');

var places = {
  ANA: 'Anaheim', BOS: 'Boston', BUF: 'Buffalo', CAR: 'Carolina', CBJ: 'Columbus',
  CGY: 'Calgary', CHI: 'Chicago', COL: 'Colorado', DAL: 'Dallas', DET: 'Detroit',
  EDM: 'Edmonton', FLA: 'Florida', LAK: 'Los Angeles', MIN: 'Minnesota',
  MTL: 'Montréal', NJD: 'New Jersey', NSH: 'Nashville', NYI: 'NY', NYR: 'NY',
  OTT: 'Ottawa', PHI: 'Philadelphia', PIT: 'Pittsburgh', SEA: 'Seattle',
  SJS: 'San Jose', STL: 'St. Louis', TBL: 'Tampa Bay', TOR: 'Toronto', UTA: 'Utah',
  VAN: 'Vancouver', VGK: 'Vegas', WPG: 'Winnipeg', WSH: 'Washington'
};

var options = Object.keys(teams).map(function(abbr) {
  return { label: places[abbr] + ' ' + teams[abbr].name, value: abbr };
}).sort(function(a, b) { return a.label < b.label ? -1 : 1; });

module.exports = [
  { type: 'heading', defaultValue: 'NHL Face' },
  {
    type: 'section',
    items: [
      {
        type: 'select',
        messageKey: 'ConfigTeam',
        label: 'Team',
        defaultValue: 'BOS',
        options: options
      }
    ]
  },
  { type: 'submit', defaultValue: 'Save' }
];
