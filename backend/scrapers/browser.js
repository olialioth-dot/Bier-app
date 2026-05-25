const puppeteer = require('puppeteer-core');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

async function closeBrowser() {
  if (browser) { await browser.close(); browser = null; }
}

module.exports = { getBrowser, closeBrowser };
