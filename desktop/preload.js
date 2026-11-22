'use strict';
// Tells the page it is running in the desktop app (so it can skip browser-only features).
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('MarginaliaDesktop', { platform: process.platform });
