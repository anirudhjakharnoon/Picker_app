// Browser-level smoke test for the Picker app, using the system Chrome via
// playwright-core (no full Playwright/browser download needed) with the
// Supabase network layer mocked (see mock-supabase.mjs).
//
// This is NOT wired into `npm run build`/`npm run test` — it needs a real
// Chrome binary and a running dev server, which may not exist in every CI
// environment. Run it manually when touching Picker/Admin interaction logic:
//
//   npm run dev -- --port 5175 --host 127.0.0.1   (in one terminal)
//   CHROME_PATH=/usr/local/bin/google-chrome node e2e/picker-smoke.mjs
//
// Every check below corresponds to a real bug this exact style of test
// caught during development — none of them were visible from a plain
// TypeScript build, lint pass, or jsdom unit test:
//   - the fixed handoff bar covering the last order card's acceptance control
//     on shorter viewports (a hardcoded CSS padding guess was wrong),
//   - the fullscreen-close button rendering as an invisible white-on-white
//     icon (missing a shared CSS class),
//   - `e.currentTarget` being null by the time an async form handler tried
//     to call `.reset()` on it after an `await` (a DOM-spec quirk, not React
//     event pooling), and
//   - an acceptance gesture accidentally behaving like a plain click.
import { chromium } from 'playwright-core';
import { installSupabaseMock, jsonRoute, makeSession, seedSession } from './mock-supabase.mjs';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5175';
const CHROME_PATH = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome';

const results = [];
function check(name, condition) {
  results.push({ name, pass: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${name}`);
}

async function withBrowser(fn) {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

const PICKER_ID = '11111111-1111-1111-1111-111111111111';
const STORE_ID = '22222222-2222-2222-2222-222222222222';
const profile = (overrides = {}) => ({
  id: PICKER_ID,
  email: 'picker@test.local',
  full_name: 'Test Picker',
  role: 'picker',
  status: 'active',
  warehouse_id: null,
  is_online: true,
  current_lat: null,
  current_lng: null,
  home_zone: null,
  max_concurrent_orders: 3,
  is_super_admin: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

function order(overrides = {}) {
  return {
    id: overrides.id ?? 'order-1',
    store_id: STORE_ID,
    external_order_ref: 'SO-99213',
    bag_count_expected: 5,
    bag_count_scanned_pickup: 0,
    bag_count_scanned_sort: 0,
    store_floor: '4th',
    store_zone: 'C',
    store_address: 'Mirdif City Centre, Level 1 - Sheikh Zayed Rd - Dubai',
    qr_mode: 'shared_order',
    shared_bag_qr_code_id: null,
    status: 'available',
    is_fragile: true,
    assigned_picker_id: null,
    warehouse_id: null,
    sort_wall_id: null,
    pigeon_hole_id: null,
    priority: 0,
    ingested_at: new Date().toISOString(),
    assigned_at: null,
    picked_at: null,
    warehouse_arrived_at: null,
    sorted_at: null,
    dispatched_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function testQueueRendersAndCardFields() {
  await withBrowser(async (browser) => {
    const session = makeSession(PICKER_ID, 'picker@test.local');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const consoleErrors = [];
    page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));

    await installSupabaseMock(page, [
      [(u) => u.includes('/auth/v1/token'), jsonRoute(200, session)],
      [(u) => u.includes('/auth/v1/user'), jsonRoute(200, session.user)],
      [(u) => u.includes('/rest/v1/profiles'), jsonRoute(200, profile())],
      [
        (u) => u.includes('/rest/v1/orders'),
        jsonRoute(200, [
          order({ id: 'o1', status: 'available' }),
        ]),
      ],
      [(u) => u.includes('/rest/v1/stores'), jsonRoute(200, [{ id: STORE_ID, external_ref: 'BUFFALO', name: 'Buffalo Burger', default_zone: 'C', status: 'active' }])],
    ]);
    await seedSession(page, session);
    await page.goto(`${BASE_URL}/picker`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const body = (await page.textContent('body')) ?? '';
    // Playwright's `page.route()` cannot intercept WebSocket upgrade
    // handshakes, so Supabase Realtime's connection attempt reaches the real
    // server with our fake anon key and is rejected — this is a test-harness
    // limitation (Realtime is explicitly best-effort/acceleration-only in
    // this app, never required for correctness), not a bug to catch here.
    const meaningfulErrors = consoleErrors.filter((e) => !/realtime|websocket/i.test(e));

    check('no persistent header/title bar (only the hamburger)', !body.includes('Picker & Sort Wall'));
    check('shows the available offer in the Pending pickup tab', body.includes('Pending pickup (1)'));
    check('order card shows "Pickup from:" + bold store name', body.includes('Pickup from:') && body.includes('Buffalo Burger'));
    check('order card shows "Floor:" and "Zone:" as separate lines', body.includes('Floor:') && body.includes('4th') && body.includes('Zone: C'));
    check('fragile order shows the Fragile Items badge', body.includes('Fragile Items'));
    check('no floating "Picked up orders" pill (removed per feedback)', !body.includes('Picked up orders'));

    const handoffButton = await page.$('.handoff-button');
    const isDisabled = handoffButton ? await handoffButton.isDisabled() : null;
    check('handoff button is disabled while an order is still in progress', isDisabled === true);

    check('no unexpected console errors on the queue screen', meaningfulErrors.length === 0);
    await page.close();
  });
}

async function testHandoffBarDoesNotCoverPickButton() {
  await withBrowser(async (browser) => {
    const session = makeSession(PICKER_ID, 'picker@test.local');
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });

    await installSupabaseMock(page, [
      [(u) => u.includes('/auth/v1/token'), jsonRoute(200, session)],
      [(u) => u.includes('/auth/v1/user'), jsonRoute(200, session.user)],
      [(u) => u.includes('/rest/v1/profiles'), jsonRoute(200, profile())],
      [(u) => u.includes('/rest/v1/orders'), jsonRoute(200, [order({ id: 'o1', status: 'available' }), order({ id: 'o2', status: 'picked', assigned_picker_id: PICKER_ID })])],
      [(u) => u.includes('/rest/v1/stores'), jsonRoute(200, [{ id: STORE_ID, external_ref: 'BUFFALO', name: 'Buffalo Burger', default_zone: 'C', status: 'active' }])],
    ]);
    await seedSession(page, session);
    await page.goto(`${BASE_URL}/picker`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);
    const pickBox = await page.$eval('.order-accept-swipe', (el) => el.getBoundingClientRect());
    const handoffBox = await page.$eval('.handoff-bar', (el) => el.getBoundingClientRect());
    const overlapsAtMaxScroll =
      pickBox.bottom > handoffBox.top &&
      pickBox.top < handoffBox.bottom &&
      pickBox.right > handoffBox.left &&
      pickBox.left < handoffBox.right;
    check('acceptance swipe is not covered by the fixed handoff bar at max scroll (360x640)', !overlapsAtMaxScroll);
    await page.close();
  });
}

async function testFullscreenScannerFitsAndHasVisibleClose() {
  await withBrowser(async (browser) => {
    const session = makeSession(PICKER_ID, 'picker@test.local');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    await installSupabaseMock(page, [
      [(u) => u.includes('/auth/v1/token'), jsonRoute(200, session)],
      [(u) => u.includes('/auth/v1/user'), jsonRoute(200, session.user)],
      [(u) => u.includes('/rest/v1/profiles'), jsonRoute(200, profile())],
      [(u) => u.includes('/rest/v1/orders'), jsonRoute(200, [order({ id: 'o1', status: 'available' })])],
      [(u) => u.includes('/rest/v1/stores'), jsonRoute(200, [{ id: STORE_ID, external_ref: 'BUFFALO', name: 'Buffalo Burger', default_zone: 'C', status: 'active' }])],
      [
        (u) => u.includes('/rest/v1/rpc/scan_bag_pickup_v1'),
        jsonRoute(200, { order_bag_id: 'b1', bag_sequence: 1, scanned: 1, expected: 5, order_status: 'picking_in_progress', idempotent_replay: false }),
      ],
      [(u) => u.includes('/rest/v1/rpc/'), jsonRoute(200, {})],
    ]);
    await seedSession(page, session);
    await page.goto(`${BASE_URL}/picker`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const accept = page.locator('.order-accept-swipe');
    const acceptBox = await accept.boundingBox();
    await page.mouse.move(acceptBox.x + 20, acceptBox.y + acceptBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(acceptBox.x + acceptBox.width - 20, acceptBox.y + acceptBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const sheetBox = await page.$eval('.fullscreen-sheet', (el) => el.getBoundingClientRect());
    const viewport = page.viewportSize();
    check('fullscreen sheet exactly covers the viewport', sheetBox.width === viewport.width && sheetBox.height === viewport.height);

    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    check('scanner screen needs no scrolling on mobile', scrollHeight === viewport.height);

    const closeBtn = await page.$('.fullscreen-close');
    const closeVisible = closeBtn ? await closeBtn.isVisible() : false;
    const closeColor = closeBtn
      ? await closeBtn.evaluate((el) => getComputedStyle(el).backgroundColor !== getComputedStyle(el).color)
      : false;
    check('close (X) button is present, visible, and not invisible (same fg/bg color)', closeVisible && closeColor);

    check('shows real "0 picked up · 5 pending" counts before any scan', (await page.textContent('body'))?.includes('0') && (await page.textContent('body'))?.includes('5 pending'));

    await page.click('button:has-text("Can\'t scan? Enter code manually")');
    await page.fill('.qr-manual-entry input', 'SO-99213-FAKE');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(400);

    const afterScan = (await page.textContent('body')) ?? '';
    check('after a scan, transitions to the per-bag confirmation with real counts', afterScan.includes('You have collected Bag #1') && afterScan.includes('4') && afterScan.includes('pending'));

    await page.close();
  });
}

async function testAdminOrderCreationFallsBackGracefully() {
  await withBrowser(async (browser) => {
    const adminId = '99999999-9999-9999-9999-999999999999';
    const session = makeSession(adminId, 'admin@test.local');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    let rpcCallCount = 0;

    await installSupabaseMock(page, [
      [(u) => u.includes('/auth/v1/token'), jsonRoute(200, session)],
      [(u) => u.includes('/auth/v1/user'), jsonRoute(200, session.user)],
      [
        (u) => u.includes('/rest/v1/profiles'),
        (route) => {
          const isPickerList = route.request().url().includes('role=eq.picker');
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(isPickerList ? [] : profile({ id: adminId, role: 'admin', is_super_admin: true })),
          });
        },
      ],
      [(u) => u.includes('/rest/v1/warehouses'), jsonRoute(200, [])],
      [(u) => u.includes('/rest/v1/sort_walls'), jsonRoute(200, [])],
      [(u) => u.includes('/rest/v1/operations_configuration'), jsonRoute(200, { singleton: true, max_orders_per_picker: 3, bags_per_pigeon_hole: 5, updated_at: new Date().toISOString(), updated_by_user_id: null })],
      [(u) => u.includes('/rest/v1/pigeon_holes'), jsonRoute(200, [])],
      [(u) => u.includes('/rest/v1/orders'), jsonRoute(200, [])],
      [
        (u) => u.includes('/rest/v1/rpc/admin_create_order_v1'),
        (route) => {
          rpcCallCount += 1;
          const body = route.request().postDataJSON();
          if ('p_store_name' in body || 'p_is_fragile' in body) {
            // Reproduces the exact error a project without migration 0005 returns.
            return route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({
                code: 'PGRST202',
                message:
                  'Could not find the function public.admin_create_order_v1(p_bag_count, p_store_address, p_store_external_ref, p_store_floor, p_store_name, p_store_zone) in the schema cache',
              }),
            });
          }
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ external_order_ref: 'SO-FALLBACK-1', shared_bag_qr_code_id: null }) });
        },
      ],
      [(u) => u.includes('/rest/v1/rpc/'), jsonRoute(200, {})],
    ]);
    await seedSession(page, session);
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // The "Store display name" field is pre-filled by default — exactly the
    // beginner scenario that originally triggered the reported error.
    await page.click('form:has(input[name="storeRef"]) button[type="submit"]');
    await page.waitForTimeout(600);

    check('extended call is attempted first, then falls back to the base signature', rpcCallCount === 2);
    const toast = (await page.textContent('.toast').catch(() => '')) ?? '';
    check('order creation succeeds via fallback instead of failing outright', toast.includes('Created order SO-FALLBACK-1'));
    check('no uncaught page error from the async form handler (e.currentTarget-after-await)', pageErrors.length === 0);

    await page.close();
  });
}

async function testHoleDropFlowShowsArrivalScreenAndVisibleErrors() {
  await withBrowser(async (browser) => {
    const session = makeSession(PICKER_ID, 'picker@test.local');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const HOLE_ID = 'hole-1';

    let verifyHoleCallCount = 0;
    let scanBagCallCount = 0;

    await installSupabaseMock(page, [
      [(u) => u.includes('/auth/v1/token'), jsonRoute(200, session)],
      [(u) => u.includes('/auth/v1/user'), jsonRoute(200, session.user)],
      [(u) => u.includes('/rest/v1/profiles'), jsonRoute(200, profile())],
      [
        (u) => u.includes('/rest/v1/orders'),
        jsonRoute(200, [
          order({
            id: 'order-1',
            status: 'sorting_in_progress',
            assigned_picker_id: PICKER_ID,
            bag_count_expected: 2,
            bag_count_scanned_sort: 0,
          }),
        ]),
      ],
      [(u) => u.includes('/rest/v1/stores'), jsonRoute(200, [])],
      [
        (u) => u.includes('/rest/v1/rpc/get_order_sorting_steps_v1'),
        jsonRoute(200, [
          { hole_id: HOLE_ID, hole_number: 'P-001', bags_reserved: 2, bags_sorted: 0, is_unlocked: true },
        ]),
      ],
      [
        (u) => u.includes('/rest/v1/rpc/verify_pigeon_hole_v1'),
        (route) => {
          verifyHoleCallCount += 1;
          if (verifyHoleCallCount === 1) {
            return route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'Wrong pigeon hole. Scan the currently unlocked hole: P-001' }),
            });
          }
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ hole_id: HOLE_ID, hole_number: 'P-001', dropped: 0, expected: 2 }),
          });
        },
      ],
      [
        (u) => u.includes('/rest/v1/rpc/scan_bag_into_pigeon_hole_v1'),
        (route) => {
          scanBagCallCount += 1;
          if (scanBagCallCount === 1) {
            return route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'Wrong bag, bag does not belong to the hole' }),
            });
          }
          const dropped = scanBagCallCount - 1;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ dropped, expected: 2, hole_complete: dropped >= 2, idempotent_replay: false }),
          });
        },
      ],
      [(u) => u.includes('/rest/v1/rpc/'), jsonRoute(200, {})],
    ]);
    await seedSession(page, session);
    await page.goto(`${BASE_URL}/picker`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    await page.click('button:has-text("Continue sorting")');
    await page.waitForTimeout(500);
    await page.click('.sorting-current-hole');
    await page.waitForTimeout(300);

    // Scan the WRONG hole first — the resulting error must be visible on
    // THIS screen (this exact toast-invisibility bug is what originally
    // made "scanning a wrong QR" look like nothing happened at all).
    await page.click('button:has-text("Can\'t scan? Enter code manually")');
    await page.fill('.qr-manual-entry input', 'WRONG-HOLE-QR');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(400);
    const holeErrorToast = await page.textContent('.fullscreen-toast').catch(() => null);
    check(
      'wrong pigeon hole error is visible on the scan screen itself',
      !!holeErrorToast && /Wrong pigeon hole/i.test(holeErrorToast)
    );

    // Now scan the correct hole.
    await page.fill('.qr-manual-entry input', 'HOLE-P-001');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(400);
    const arrivalBody = (await page.textContent('body')) ?? '';
    check(
      'shows "Arrived at Pigeon Hole" screen with a "Scan Bags X/Y" button',
      arrivalBody.includes('Arrived at Pigeon Hole P-001') && arrivalBody.includes('Scan Bags 0/2')
    );

    await page.click('button:has-text("Scan Bags 0/2")');
    await page.waitForTimeout(300);

    // Scan the WRONG bag — again, the error must be visible on this screen.
    await page.click('button:has-text("Can\'t scan? Enter code manually")');
    await page.fill('.qr-manual-entry input', 'WRONG-BAG-QR');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(400);
    const bagErrorToast = await page.textContent('.fullscreen-toast').catch(() => null);
    check(
      'wrong bag error ("Wrong bag, bag does not belong to the hole") is visible on the scan screen',
      !!bagErrorToast && /Wrong bag, bag does not belong to the hole/i.test(bagErrorToast)
    );

    // Scan the correct first bag — expect a per-bag success screen with the
    // same bags-grid visual style as the pickup flow, not a silent no-op.
    await page.fill('.qr-manual-entry input', 'BAG-QR-1');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(400);
    const firstBagBody = (await page.textContent('body')) ?? '';
    check(
      'each correct bag scan shows an explicit success screen with the bags grid',
      firstBagBody.includes('You have dropped Bag #1') && (await page.$('.bags-grid')) !== null
    );

    await page.click('button:has-text("Drop next bag")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("Can\'t scan? Enter code manually")');
    await page.fill('.qr-manual-entry input', 'BAG-QR-2');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(400);
    const completeBody = (await page.textContent('body')) ?? '';
    check('hole completion screen shows once every allocated bag is dropped', completeBody.includes('Pigeon hole P-001 complete'));

    await page.close();
  });
}

async function testScanFailureDoesNotPermanentlyFreezeTheScanner() {
  await withBrowser(async (browser) => {
    const session = makeSession(PICKER_ID, 'picker@test.local');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const HOLE_ID = 'hole-1';
    let scanBagCallCount = 0;

    await installSupabaseMock(page, [
      [(u) => u.includes('/auth/v1/token'), jsonRoute(200, session)],
      [(u) => u.includes('/auth/v1/user'), jsonRoute(200, session.user)],
      [(u) => u.includes('/rest/v1/profiles'), jsonRoute(200, profile())],
      [
        (u) => u.includes('/rest/v1/orders'),
        jsonRoute(200, [
          order({ id: 'order-1', status: 'sorting_in_progress', assigned_picker_id: PICKER_ID, bag_count_expected: 2, bag_count_scanned_sort: 0 }),
        ]),
      ],
      [(u) => u.includes('/rest/v1/stores'), jsonRoute(200, [])],
      [
        (u) => u.includes('/rest/v1/rpc/get_order_sorting_steps_v1'),
        jsonRoute(200, [{ hole_id: HOLE_ID, hole_number: 'P-001', bags_reserved: 2, bags_sorted: 0, is_unlocked: true }]),
      ],
      [(u) => u.includes('/rest/v1/rpc/verify_pigeon_hole_v1'), jsonRoute(200, { hole_id: HOLE_ID, hole_number: 'P-001', dropped: 0, expected: 2 })],
      [
        // Simulates a genuine network-level failure (not a normal RPC
        // rejection) on the FIRST bag scan — this is the class of failure
        // an un-caught exception would previously leave permanently stuck
        // with zero visible feedback.
        (u) => u.includes('/rest/v1/rpc/scan_bag_into_pigeon_hole_v1'),
        (route) => {
          scanBagCallCount += 1;
          if (scanBagCallCount === 1) return route.abort('connectionfailed');
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ dropped: 1, expected: 2, hole_complete: false, idempotent_replay: false }),
          });
        },
      ],
      [(u) => u.includes('/rest/v1/rpc/'), jsonRoute(200, {})],
    ]);
    await seedSession(page, session);
    await page.goto(`${BASE_URL}/picker`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    await page.click('button:has-text("Continue sorting")');
    await page.waitForTimeout(400);
    await page.click('.sorting-current-hole');
    await page.waitForTimeout(300);
    await page.click('button:has-text("Can\'t scan? Enter code manually")');
    await page.fill('.qr-manual-entry input', 'HOLE-P-001');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Scan Bags 0/2")');
    await page.waitForTimeout(300);

    // First attempt: simulated network failure.
    await page.click('button:has-text("Can\'t scan? Enter code manually")');
    await page.fill('.qr-manual-entry input', 'BAG-QR-1');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(500);
    const errorToast = await page.textContent('.fullscreen-toast').catch(() => null);
    check('a network-level scan failure shows a visible error instead of nothing', !!errorToast);

    // Second attempt on the SAME screen, no reload: must actually go
    // through, proving the first failure did not leave the scanner stuck.
    await page.fill('.qr-manual-entry input', 'BAG-QR-1');
    await page.click('.qr-manual-entry button[type="submit"]');
    await page.waitForTimeout(500);
    const afterRetryBody = (await page.textContent('body')) ?? '';
    check(
      'retrying the same scan after a failure succeeds (scanner was not left permanently stuck)',
      afterRetryBody.includes('You have dropped Bag #1')
    );

    await page.close();
  });
}

await testQueueRendersAndCardFields();
await testHandoffBarDoesNotCoverPickButton();
await testFullscreenScannerFitsAndHasVisibleClose();
await testHoleDropFlowShowsArrivalScreenAndVisibleErrors();
await testScanFailureDoesNotPermanentlyFreezeTheScanner();
await testAdminOrderCreationFallsBackGracefully();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log('FAILED:', failed.map((f) => f.name).join('; '));
  process.exit(1);
}
