const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'run-share-ordinary-independent.cjs'), 'utf8');
const anchor = "'user-spread-poster-data'].map";
if (source.split(anchor).length !== 2) throw Error('Expected exact runner files anchor');
const candidate = source.replace(anchor, "'user-spread-poster-data','legacy-user-routine-code','user-profile-migration','wechat-mini-program-code'].map")
  .replace('Independent LOCAL complete QR/follow/media/registered createApp HTTP ordinary suite; main current repository is active and not claimed frozen.', 'Independent LOCAL personal routine alias plus complete QR/follow/media/registered createApp HTTP, profile and existing mini-program regression; current Source remains active and alias candidates are not written to Source.');
const target = path.join(__dirname, 'run-user-routine-regression-generated.cjs');
if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== candidate) throw Error('Existing different generated runner');
fs.writeFileSync(target, candidate);
require(target);
