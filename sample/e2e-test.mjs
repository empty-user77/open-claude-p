import { chromium } from 'playwright';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const BASE = 'http://localhost:3000';

// Clean claude project memory for open-claude-p to avoid test contamination
// across repeated e2e runs (claude auto-memory stores test data like "42").
async function cleanProjectMemory() {
  const cwd = path.resolve('.');
  const encoded = cwd.replace(/\//g, '-');
  const memDir = path.join(homedir(), '.claude', 'projects', encoded, 'memory');
  try {
    await rm(memDir, { recursive: true, force: true });
    await mkdir(memDir, { recursive: true });
    await writeFile(path.join(memDir, 'MEMORY.md'), '');
    console.log('  🧹 project memory cleared');
  } catch { /* ignore if dir doesn't exist */ }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name) {
  const path = `/tmp/ocp-sample-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 screenshot → ${path}`);
}

(async () => {
  await cleanProjectMemory();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);

  let pass = 0;
  let fail = 0;

  function ok(label) { console.log(`  ✅ ${label}`); pass++; }
  function ko(label, err) { console.log(`  ❌ ${label}: ${err?.message ?? err}`); fail++; }

  console.log('\n── Test 1: Page loads ─────────────────────────────────────');
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    await screenshot(page, '01-initial');
    const title = await page.title();
    if (title.includes('Claude')) ok(`title="${title}"`);
    else ko('title check', `got "${title}"`);
  } catch (e) { ko('page load', e); }

  console.log('\n── Test 2: Welcome screen visible ─────────────────────────');
  try {
    const welcome = page.locator('#welcome');
    await welcome.waitFor({ state: 'visible' });
    ok('welcome screen shown');
    const messages = page.locator('#messages');
    const msgDisplay = await messages.evaluate(el => getComputedStyle(el).display);
    if (msgDisplay === 'none') ok('messages panel hidden initially');
    else ko('messages panel should be hidden', `display=${msgDisplay}`);
  } catch (e) { ko('welcome screen', e); }

  console.log('\n── Test 3: Send a message ──────────────────────────────────');
  try {
    const input = page.locator('#messageInput');
    await input.fill('Hello! Say exactly: READY');
    await screenshot(page, '02-before-send');
    await input.press('Enter');

    // Wait for typing indicator to appear
    await page.locator('.typing-indicator').waitFor({ state: 'visible', timeout: 8_000 });
    ok('typing indicator shown');
    await screenshot(page, '03-typing');

    // Wait for response (up to 45s for claude to respond)
    await page.locator('.typing-indicator').waitFor({ state: 'detached', timeout: 90_000 });
    ok('typing indicator removed after response');

    // Check message appeared
    const msgs = page.locator('.message');
    const count = await msgs.count();
    if (count >= 2) ok(`${count} messages rendered (user + assistant)`);
    else ko('messages count', `expected ≥2, got ${count}`);

    await screenshot(page, '04-response');

    // Check response text is not garbage (spinner chars)
    const assistantBody = page.locator('.message.assistant .message-body').last();
    const text = await assistantBody.innerText();
    console.log(`  response text: "${text.slice(0, 120)}"`);
    const hasSpinnerGarbage = /[✢✳✽✻✶·].*thinking/.test(text);
    if (!hasSpinnerGarbage) ok('no spinner garbage in response');
    else ko('spinner garbage detected', text.slice(0, 80));
    if (text.trim().length > 0) ok('response is non-empty');
    else ko('response is empty', '');
  } catch (e) { ko('send message', e); await screenshot(page, '04-error'); }

  console.log('\n── Test 4: Conversation saved to sidebar ───────────────────');
  try {
    await sleep(1000);
    const convItems = page.locator('.conv-item');
    const count = await convItems.count();
    if (count >= 1) ok(`${count} conversation(s) in sidebar`);
    else ko('sidebar empty', '');
    await screenshot(page, '05-sidebar');
  } catch (e) { ko('sidebar check', e); }

  console.log('\n── Test 5: Multi-turn conversation (context retention) ─────');
  try {
    const input = page.locator('#messageInput');
    const sendBtn = page.locator('#sendBtn');
    await sleep(500);
    await input.click();
    await input.fill('My secret number is 42. Remember it.');
    await sleep(200);
    await sendBtn.click();
    // Wait for sendBtn to re-enable — setLoading(false) fires only after done event.
    await page.waitForFunction(() => !document.getElementById('sendBtn').disabled, { timeout: 90_000 });
    ok('turn 1 done');

    await sleep(300);
    await input.click();
    await input.fill('What was my secret number?');
    await sleep(200);
    await sendBtn.click();
    await page.waitForFunction(() => !document.getElementById('sendBtn').disabled, { timeout: 90_000 });
    ok('turn 2 done');

    const lastResp = page.locator('.message.assistant .message-body').last();
    const text = await lastResp.innerText();
    console.log(`  context check text: "${text.slice(0, 120)}"`);
    if (text.includes('42')) ok('context retained — "42" found in response');
    else ko('context not retained', `"42" missing from: ${text.slice(0, 80)}`);
    await screenshot(page, '06-multiturn');
  } catch (e) { ko('multi-turn', e); await screenshot(page, '06-error'); }

  console.log('\n── Test 6: New Chat button ─────────────────────────────────');
  try {
    await page.locator('#newChatBtn').click();
    await page.locator('#welcome').waitFor({ state: 'visible', timeout: 3_000 });
    ok('new chat resets to welcome screen');
    await screenshot(page, '07-newchat');
  } catch (e) { ko('new chat', e); }

  console.log('\n── Test 7: PTY terminal panel visible ──────────────────────');
  try {
    const termPanel = page.locator('#terminalPanel');
    const visible = await termPanel.isVisible();
    if (visible) ok('terminal panel visible');
    else ko('terminal panel not visible', '');

    const termLines = page.locator('.term-line');
    const lineCount = await termLines.count();
    if (lineCount > 0) ok(`${lineCount} PTY event line(s) in monitor`);
    else ko('no PTY monitor events', '');
    await screenshot(page, '08-terminal');
  } catch (e) { ko('terminal panel', e); }

  console.log('\n── Test 8: WebSearch (real-time query) ─────────────────────');
  try {
    // Clear memory again so Test 5's "42" doesn't contaminate this fresh session.
    await cleanProjectMemory();
    await page.locator('#newChatBtn').click();
    await page.locator('#welcome').waitFor({ state: 'visible', timeout: 3_000 });

    const input = page.locator('#messageInput');
    const sendBtn = page.locator('#sendBtn');
    await input.fill('tell me the current weather in Seoul');
    await sendBtn.click();

    await page.locator('.typing-indicator').waitFor({ state: 'visible', timeout: 12_000 });
    ok('typing indicator shown for real-time query');

    // Wait for sendBtn to re-enable — setLoading(false) fires only after the
    // full SSE stream ends (post-done), so this is a reliable signal that the
    // final clean text has been written into the DOM.
    await page.waitForFunction(() => !document.getElementById('sendBtn').disabled, { timeout: 120_000 });
    ok('response received (send button re-enabled)');

    const body = page.locator('.message.assistant .message-body').last();

    const text = await body.innerText();
    console.log(`  response preview: "${text.slice(0, 150)}"`);

    // Must not say it cannot access real-time data
    const refusedSearch = /cannot (?:access|retrieve|provide).*real[- ]?time|don[''`]?t have.*real[- ]?time|no access to.*real[- ]?time|unable to.*real[- ]?time/i.test(text);
    if (!refusedSearch) ok('no "cannot access" refusal — WebSearch was used');
    else ko('WebSearch NOT used — Claude refused real-time query', text.slice(0, 100));

    // Should contain weather-related content
    const hasWeatherContent = /°|degrees?|sunny|cloud|rain|humidity|temperature|wind|weather|\d+/i.test(text);
    if (hasWeatherContent) ok('response contains real weather data');
    else ko('response missing actual weather data', text.slice(0, 100));

    await screenshot(page, '09-websearch');
  } catch (e) { ko('WebSearch real-time query', e); await screenshot(page, '09-error'); }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  console.log(`Screenshots in /tmp/ocp-sample-*.png\n`);

  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
