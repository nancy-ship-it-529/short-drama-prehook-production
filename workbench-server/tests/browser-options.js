const fs = require('fs');
const path = require('path');
const chrome = process.env.CHROME_BIN || path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
module.exports = fs.existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true };
