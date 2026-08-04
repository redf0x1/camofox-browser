// Unit test: verify that evaluate and delete route handlers validate userId
// Before the fix: evaluate returned 404 "Tab not found" (confusing),
// delete returned { ok: true } (silent no-op). After fix: both return 400.

describe('userId validation regression (core.ts routes)', () => {
  const fs = require('fs');
  const path = require('path');
  const sourcePath = path.join(__dirname, '../../src/routes/core.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');

  test('evaluate handler validates userId before findTabById', () => {
    const evalMatch = source.match(/router\.post\(\s*['"]\/tabs\/:tabId\/evaluate['"]/);
    expect(evalMatch).not.toBeNull();
    const evalStart = source.indexOf(evalMatch[0]);
    const nextRoute = source.indexOf('router.', evalStart + 1);
    const handlerBlock = source.substring(evalStart, nextRoute > 0 ? nextRoute : evalStart + 2000);
    expect(handlerBlock).toContain("if (!userId)");
    expect(handlerBlock).toContain("'userId is required'");
  });

  test('delete handler validates userId before findTabById', () => {
    const deleteMatch = source.match(/router\.delete\(\s*['"]\/tabs\/:tabId['"]/);
    expect(deleteMatch).not.toBeNull();
    const deleteStart = source.indexOf(deleteMatch[0]);
    const nextRoute = source.indexOf('router.', deleteStart + 1);
    const handlerBlock = source.substring(deleteStart, nextRoute > 0 ? nextRoute : deleteStart + 1000);
    expect(handlerBlock).toContain("if (!userId)");
    expect(handlerBlock).toContain("'userId is required'");
  });

  test('delete handler does NOT silently return ok:true when userId is missing', () => {
    const deleteMatch = source.match(/router\.delete\(\s*['"]\/tabs\/:tabId['"]/);
    const deleteStart = source.indexOf(deleteMatch[0]);
    const nextRoute = source.indexOf('router.', deleteStart + 1);
    const handlerBlock = source.substring(deleteStart, nextRoute > 0 ? nextRoute : deleteStart + 1000);
    const guardPos = handlerBlock.indexOf("if (!userId)");
    const findTabPos = handlerBlock.indexOf("findTabById");
    expect(guardPos).toBeGreaterThan(-1);
    expect(findTabPos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(findTabPos);
  });

  test('evaluate handler guard is consistent with evaluate-extended handler', () => {
    const extMatch = source.match(/router\.post\(\s*['"]\/tabs\/:tabId\/evaluate-extended['"]/);
    const extStart = source.indexOf(extMatch[0]);
    const extNext = source.indexOf('router.', extStart + 1);
    const extBlock = source.substring(extStart, extNext > 0 ? extNext : extStart + 2000);
    const evalMatch = source.match(/router\.post\(\s*['"]\/tabs\/:tabId\/evaluate['"]\s*,/);
    const evalStart = source.indexOf(evalMatch[0]);
    const evalNext = source.indexOf('router.', evalStart + 1);
    const evalBlock = source.substring(evalStart, evalNext > 0 ? evalNext : evalStart + 2000);
    expect(extBlock).toContain("userId");
    expect(evalBlock).toContain("if (!userId)");
  });
});
