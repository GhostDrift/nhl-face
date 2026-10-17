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
      },
      {
        type: 'toggle',
        messageKey: 'ConfigAwayColors',
        label: 'Away colors on away game days',
        description: 'White with your team color, like the road jersey.',
        defaultValue: true
      },
      {
        type: 'toggle',
        messageKey: 'ConfigVibeOnGoal',
        label: 'Vibrate when your team scores',
        description: 'Checked every 20 seconds during games. Skipped while Quiet Time is on.',
        defaultValue: false
      },
      {
        type: 'select',
        messageKey: 'ConfigGoalNotify',
        label: 'Goal alerts',
        description: 'The scorer, assists, and score when your team scores, as a phone notification or as a banner on the face.',
        defaultValue: 'off',
        options: [
          { label: 'Off', value: 'off' },
          { label: 'Phone notification', value: 'notify' },
          { label: 'Banner on the watch face', value: 'banner' }
        ]
      },
      {
        type: 'select',
        messageKey: 'ConfigBannerSecs',
        label: 'Banner duration',
        description: 'How long the goal banner stays up.',
        defaultValue: '30',
        options: [
          { label: '15 seconds', value: '15' },
          { label: '30 seconds', value: '30' },
          { label: '1 minute', value: '60' },
          { label: '2 minutes', value: '120' },
          { label: '5 minutes', value: '300' }
        ]
      },
      {
        type: 'toggle',
        messageKey: 'ConfigVibeOnPeriod',
        label: 'Vibrate when a period starts or ends',
        description: 'Includes puck drop, intermissions, overtime, and shootouts.',
        defaultValue: false
      },
      {
        type: 'toggle',
        messageKey: 'ConfigVibeOnFinal',
        label: 'Vibrate when the game ends',
        defaultValue: false
      },
      {
        type: 'toggle',
        messageKey: 'VibeOnDisconnect',
        label: 'Vibrate when the phone disconnects',
        description: 'Skipped while Quiet Time is on.',
        defaultValue: false
      }
    ]
  },
  { type: 'submit', defaultValue: 'Save' }
];
