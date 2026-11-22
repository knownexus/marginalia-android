'use strict';
// The desktop app bundles the same single-file page as the Android app, so it works offline.
const fs = require('fs');
const path = require('path');
fs.copyFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'index.html'), path.join(__dirname, '..', 'index.html'));
console.log('Copied index.html');
