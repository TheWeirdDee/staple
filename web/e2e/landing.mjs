import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.STAPLE_LANDING_URL || 'http://127.0.0.1:5180/staple/';
const screenshots = join(root, 'docs', 'screenshots');
const results = [];
const errors = [];
mkdirSync(screenshots, { recursive: true });
function check(name, ok, detail) {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(base))
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  const widths = [320, 360, 390, 430, 600, 768, 860, 900, 1024, 1280, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    const layout = await page.evaluate(() => {
      const headings = [
        ...document.querySelectorAll(
          '.lp h1:not(.visually-hidden), .lp h2:not(.visually-hidden), .lp h3:not(.visually-hidden)'
        ),
      ];
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        clipped: headings
          .filter((h) => {
            const r = h.getBoundingClientRect();
            return (
              r.left < -1 ||
              r.right > innerWidth + 1 ||
              h.scrollWidth > h.clientWidth + 2
            );
          })
          .map((h) => h.textContent),
      };
    });
    check(
      `Responsive layout at ${width}px`,
      !layout.overflow && !layout.clipped.length,
      JSON.stringify(layout)
    );
    if (width === 390 || width === 1440) {
      const name = width === 390 ? 'mobile' : 'desktop';
      await page.screenshot({
        path: join(screenshots, `landing-redesign-${name}.png`),
        fullPage: true,
      });
      await page.screenshot({
        path: join(screenshots, `landing-redesign-${name}-hero.png`),
      });
    }
  }
  check(
    'One H1 and all six FAQ questions',
    (await page.locator('h1').count()) === 1 &&
      (await page.locator('.lp-questions details').count()) === 6
  );
  check(
    'Reduced motion uses a static example',
    (await page
      .locator('.lp-workflow')
      .getAttribute('class')
      .then((v) => v.includes('lp-phase-2'))) &&
      (await page
        .getByRole('button', {
          name: 'Animation disabled by reduced motion preference',
        })
        .isDisabled())
  );
  const textureTransform = await page
    .locator('.lp-hero-texture')
    .evaluate((el) => getComputedStyle(el).transform);
  check(
    'Reduced motion disables background movement',
    textureTransform === 'none'
  );
  for (const question of await page.locator('.lp-questions summary').all()) {
    await question.click();
    check(
      `FAQ: ${await question.innerText()}`,
      await question.evaluate((el) => el.parentElement.open)
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#faq-heading').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(screenshots, 'landing-redesign-mobile-faq.png'),
  });
  await page.getByLabel('Spread', { exact: false }).first().focus();
  await page.keyboard.press('ArrowRight');
  check(
    'Example spread control responds to keyboard input',
    await page
      .locator('output[for="example-spread"]')
      .innerText()
      .then((v) => v.includes('40 bps'))
  );
  await page.getByLabel('Order size', { exact: false }).focus();
  await page.keyboard.press('ArrowRight');
  check(
    'Example size control responds to keyboard input',
    await page
      .locator('output[for="example-size"]')
      .innerText()
      .then((v) => v.includes('25 tokens'))
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  check(
    'Mobile navigation opens',
    (await page
      .getByRole('button', { name: 'Close', exact: true })
      .getAttribute('aria-expanded')) === 'true'
  );
  await page.screenshot({
    path: join(screenshots, 'landing-redesign-mobile-menu.png'),
  });
  await page.keyboard.press('Escape');
  check(
    'Escape closes mobile menu and returns focus',
    await page
      .getByRole('button', { name: 'Menu', exact: true })
      .evaluate(
        (el) =>
          document.activeElement === el &&
          el.getAttribute('aria-expanded') === 'false'
      )
  );
  for (const [label, id] of [
    ['How it works', 'how-it-works'],
    ['Controls', 'controls'],
    ['Evidence', 'evidence'],
  ]) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page
      .locator('#primary-nav')
      .getByRole('link', { name: label, exact: true })
      .click();
    await page.waitForTimeout(100);
    const top = await page
      .locator(`#${id}`)
      .evaluate((el) => el.getBoundingClientRect().top);
    check(
      `Mobile anchor ${label} clears sticky navigation`,
      top >= 90 && top < 150,
      String(top)
    );
    check(
      `Mobile anchor ${label} closes menu`,
      (await page
        .getByRole('button', { name: 'Menu', exact: true })
        .getAttribute('aria-expanded')) === 'false'
    );
  }
  await page.reload({ waitUntil: 'networkidle' });
  check(
    'Refresh preserves section deep link',
    await page.locator('#evidence').evaluate((el) => {
      const y = el.getBoundingClientRect().top;
      return y >= 90 && y < 150;
    })
  );
  const targets = await page
    .locator('.landing-shell a')
    .evaluateAll((links) => [
      ...new Set(
        links
          .map((a) => a.getAttribute('href'))
          .filter((href) => href?.startsWith('#/'))
      ),
    ]);
  for (const target of targets) {
    await page.goto(`${base}${target}`, { waitUntil: 'networkidle' });
    check(
      `Internal destination ${target}`,
      !(await page.getByRole('heading', { name: 'Page not found.' }).count()) &&
        (await page
          .locator('main')
          .innerText()
          .then((t) => t.trim().length > 20))
    );
  }
  // 1280 physical pixels at 200% browser zoom has a 640 CSS-pixel layout viewport.
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto(base, { waitUntil: 'networkidle' });
  check(
    '200% zoom reflow equivalent at 640 CSS px',
    (await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )) && (await page.getByRole('heading', { level: 1 }).isVisible())
  );
  await page.keyboard.press('Tab');
  check(
    'Skip link is first keyboard stop',
    await page.evaluate(
      () => document.activeElement?.textContent === 'Skip to content'
    )
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'main');
  check(
    'Skip link focuses main without breaking hash routing',
    await page.evaluate(
      () =>
        document.activeElement?.id === 'main' && !location.hash.includes('main')
    )
  );
  check(
    'Hero artwork loads from the configured base path',
    await page.evaluate(async () => {
      const url = getComputedStyle(
        document.querySelector('.lp-hero-texture')
      ).backgroundImage.slice(5, -2);
      return (await fetch(url)).ok;
    })
  );
  await page
    .getByRole('button', { name: 'Show quotes withdrawn', exact: true })
    .click();
  check(
    'Reduced motion still permits manual workflow exploration',
    await page
      .locator('.lp-workflow')
      .getAttribute('class')
      .then((v) => v.includes('lp-phase-4'))
  );
  const firstQuestion = page.locator('.lp-questions summary').first();
  await firstQuestion.focus();
  await page.keyboard.press('Enter');
  check(
    'FAQ opens using the keyboard',
    await firstQuestion.evaluate((el) => el.parentElement.open)
  );
  await page.keyboard.press('Space');
  check(
    'FAQ closes using the keyboard',
    await firstQuestion.evaluate((el) => !el.parentElement.open)
  );
  await context.close();

  const motionContext = await browser.newContext({
    reducedMotion: 'no-preference',
    viewport: { width: 1440, height: 1000 },
  });
  const motionPage = await motionContext.newPage();
  await motionPage.goto(base, { waitUntil: 'networkidle' });
  await motionPage.locator('.lp-workflow').scrollIntoViewIfNeeded();
  for (const [label, phase] of [
    ['quotes placed', 1],
    ['execution checked', 2],
    ['cancelling quotes', 3],
    ['quotes withdrawn', 4],
  ]) {
    await motionPage
      .getByRole('button', { name: `Show ${label}`, exact: true })
      .click();
    check(
      `Illustration step: ${label}`,
      await motionPage
        .locator('.lp-workflow')
        .getAttribute('class')
        .then((v) => v.includes(`lp-phase-${phase}`))
    );
  }
  check(
    'Illustration distinguishes pending and confirmed cancellation',
    await motionPage
      .locator('.lp-book-caption')
      .innerText()
      .then((v) => v.includes('Cancellation confirmed'))
  );
  await motionPage
    .getByRole('button', { name: 'Play workflow animation' })
    .click();
  await motionPage.waitForTimeout(3350);
  check(
    'Workflow animation advances while visible',
    await motionPage
      .locator('.lp-workflow')
      .getAttribute('class')
      .then((v) => !v.includes('lp-phase-4'))
  );
  await motionPage
    .getByRole('button', { name: 'Pause workflow animation' })
    .click();
  const pausedPhase = await motionPage
    .locator('.lp-workflow')
    .getAttribute('class');
  await motionPage.waitForTimeout(3350);
  check(
    'Workflow animation can be paused',
    (await motionPage.locator('.lp-workflow').getAttribute('class')) ===
      pausedPhase
  );
  await motionPage.evaluate(() =>
    window.scrollTo({
      top: document.getElementById('how-it-works').offsetTop - 400,
      behavior: 'instant',
    })
  );
  await motionPage.waitForTimeout(150);
  const progressBefore = await motionPage
    .locator('.lp-progress > div')
    .evaluate((el) => getComputedStyle(el).transform);
  await motionPage.evaluate(() => {
    const section = document.getElementById('how-it-works');
    window.scrollTo({
      top: section.offsetTop + section.offsetHeight - 400,
      behavior: 'instant',
    });
  });
  await motionPage.waitForTimeout(300);
  check(
    'Process progress responds to scrolling',
    (await motionPage
      .locator('.lp-progress > div')
      .evaluate((el) => getComputedStyle(el).transform)) !== progressBefore
  );
  await motionPage.evaluate(() =>
    window.scrollTo({ top: 0, behavior: 'instant' })
  );
  await motionPage.mouse.move(1400, 300);
  await motionPage.waitForTimeout(250);
  check(
    'Fine-pointer parallax responds to movement',
    await motionPage
      .locator('.lp-hero-texture')
      .evaluate(
        (el) =>
          !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(
            getComputedStyle(el).transform
          )
      )
  );
  await motionPage.locator('.lp-workflow').scrollIntoViewIfNeeded();
  await motionPage
    .getByRole('button', { name: 'Play workflow animation' })
    .click();
  await motionPage.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
  );
  await motionPage.waitForTimeout(150);
  const offscreenPhase = await motionPage
    .locator('.lp-workflow')
    .getAttribute('class');
  await motionPage.waitForTimeout(3350);
  check(
    'Workflow stops updating offscreen',
    (await motionPage.locator('.lp-workflow').getAttribute('class')) ===
      offscreenPhase
  );
  await motionContext.close();
  check(
    'No runtime, console, or local HTTP errors',
    errors.length === 0,
    errors.join('; ')
  );
} finally {
  await browser.close();
  writeFileSync(
    join(root, 'runs', 'landing-redesign.json'),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        base,
        scope:
          'Production web preview in Chromium; illustrative workflow only. Zoom check uses the equivalent CSS layout viewport.',
        results,
        errors,
      },
      null,
      2
    ) + '\n'
  );
}
assert(
  results.length > 0 && results.every((result) => result.ok),
  'Landing browser checks failed'
);
