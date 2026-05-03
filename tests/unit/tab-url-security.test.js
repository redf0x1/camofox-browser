jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

describe('validateUrl() network safety', () => {
  let validateUrl;
  let validateNavigationUrl;
  let navigateWithSafetyGuard;
  let createTabState;
  let clickTab;
  let evaluateTab;
  let pressTab;
  let scrollElementTab;
  let scrollTab;
  let typeTab;
  let waitForPageReady;
  let lookupMock;
  const originalHost = process.env.CAMOFOX_HOST;
  const originalApiKey = process.env.CAMOFOX_API_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.CAMOFOX_HOST = '0.0.0.0';
    process.env.CAMOFOX_API_KEY = 'test-key';
    ({ lookup: lookupMock } = require('node:dns/promises'));
    lookupMock.mockReset();
    ({ validateUrl, validateNavigationUrl, navigateWithSafetyGuard, createTabState, clickTab, evaluateTab, pressTab, scrollElementTab, scrollTab, typeTab, waitForPageReady } =
      require('../../dist/src/services/tab'));
  });

  afterEach(() => {
    if (originalHost === undefined) delete process.env.CAMOFOX_HOST;
    else process.env.CAMOFOX_HOST = originalHost;
    if (originalApiKey === undefined) delete process.env.CAMOFOX_API_KEY;
    else process.env.CAMOFOX_API_KEY = originalApiKey;
  });

  test('allows localhost targets when private-network access is enabled', () => {
    expect(validateUrl('http://127.0.0.1:3000', { allowPrivateNetworkTargets: true })).toBeNull();
    expect(validateUrl('http://localhost:8080', { allowPrivateNetworkTargets: true })).toBeNull();
  });

  test('blocks loopback, RFC1918, and metadata targets when private-network access is disabled', () => {
    expect(validateUrl('http://127.0.0.1:3000', { allowPrivateNetworkTargets: false })).toContain(
      'Blocked private network target',
    );
    expect(validateUrl('http://192.168.1.25', { allowPrivateNetworkTargets: false })).toContain(
      'Blocked private network target',
    );
    expect(validateUrl('http://169.254.169.254/latest/meta-data', { allowPrivateNetworkTargets: false })).toContain(
      'Blocked private network target',
    );
    expect(
      validateUrl('http://metadata.google.internal/computeMetadata/v1', { allowPrivateNetworkTargets: false }),
    ).toContain('Blocked private network target');
  });

  test('still blocks non-http schemes', () => {
    expect(validateUrl('file:///etc/passwd', { allowPrivateNetworkTargets: true })).toContain('Blocked URL scheme');
  });

  test('blocks hostnames that resolve to private addresses when private-network access is disabled', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      validateNavigationUrl('http://public-looking.example.test/resource', { allowPrivateNetworkTargets: false }),
    ).resolves.toContain('Blocked private network target');
  });

  test('blocks hex-encoded IPv6-mapped loopback literals when private-network access is disabled', async () => {
    await expect(
      validateNavigationUrl('http://[::ffff:7f00:1]/latest/meta-data', { allowPrivateNetworkTargets: false }),
    ).resolves.toContain('Blocked private network target');
  });

  test('blocks NAT64-encoded private IPv4 literals when private-network access is disabled', async () => {
    await expect(
      validateNavigationUrl('http://[64:ff9b::a9fe:a9fe]/latest/meta-data', { allowPrivateNetworkTargets: false }),
    ).resolves.toContain('Blocked private network target');
  });

  test('aborts redirect chains that land on private targets', async () => {
    lookupMock.mockImplementation(async (hostname) => {
      if (hostname === 'public.example.test') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      if (hostname === '169.254.169.254') {
        return [{ address: '169.254.169.254', family: 4 }];
      }
      return [];
    });

    let routeHandler;
    const initialRoute = {
      request: () => ({
        url: () => 'http://public.example.test/start',
        isNavigationRequest: () => true,
        frame: () => ({ page: () => page }),
      }),
      continue: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    };
    const redirectedRoute = {
      request: () => ({
        url: () => 'http://169.254.169.254/latest/meta-data',
        isNavigationRequest: () => true,
        frame: () => ({ page: () => page }),
      }),
      continue: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      goto: jest.fn(async () => {
        await routeHandler(initialRoute);
        await routeHandler(redirectedRoute);
        throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      }),
    };

    await expect(async () => {
      try {
        await navigateWithSafetyGuard(page, 'http://public.example.test/start', {
          allowPrivateNetworkTargets: false,
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch (err) {
        expect(err.statusCode).toBe(400);
        throw err;
      }
    }).rejects.toThrow('Blocked private network target');
    expect(initialRoute.continue).toHaveBeenCalledTimes(1);
    expect(redirectedRoute.abort).toHaveBeenCalledTimes(1);
  });

  test('keeps the navigation guard installed after goto so later client-side navigations stay blocked', async () => {
    lookupMock.mockImplementation(async (hostname) => {
      if (hostname === 'public.example.test') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      if (hostname === '169.254.169.254') {
        return [{ address: '169.254.169.254', family: 4 }];
      }
      return [];
    });

    let routeHandler;
    const initialRoute = {
      request: () => ({
        url: () => 'http://public.example.test/start',
        isNavigationRequest: () => true,
        frame: () => 'main-frame',
      }),
      continue: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    };
    const laterRoute = {
      request: () => ({
        url: () => 'http://169.254.169.254/latest/meta-data',
        isNavigationRequest: () => true,
        frame: () => 'main-frame',
      }),
      continue: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      goto: jest.fn(async () => {
        await routeHandler(initialRoute);
      }),
    };

    await navigateWithSafetyGuard(page, 'http://public.example.test/start', {
      allowPrivateNetworkTargets: false,
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await routeHandler(laterRoute);
    expect(context.route).toHaveBeenCalledTimes(1);
    expect(laterRoute.abort).toHaveBeenCalledTimes(1);
  });

  test('createTabState installs the restricted navigation guard before blank tabs can navigate later', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    let routeHandler;
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const laterRoute = {
      request: () => ({
        url: () => 'http://169.254.169.254/latest/meta-data',
        isNavigationRequest: () => true,
      }),
      continue: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn(),
      mainFrame: jest.fn(() => 'main-frame'),
    };

    await createTabState(page);
    await routeHandler(laterRoute);

    expect(context.route).toHaveBeenCalledTimes(1);
    expect(laterRoute.abort).toHaveBeenCalledTimes(1);
  });

  test('evaluateTab surfaces blocked top-level navigations as statusCode 400 errors', async () => {
    let routeHandler;
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn(),
      evaluate: jest.fn(async () => {
        await routeHandler({
          request: () => ({
            url: () => 'http://169.254.169.254/latest/meta-data',
            isNavigationRequest: () => true,
            frame: () => ({ page: () => page }),
          }),
          continue: jest.fn().mockResolvedValue(undefined),
          abort: jest.fn().mockResolvedValue(undefined),
        });
        return 'ok';
      }),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const tabState = await createTabState(page);

    await expect(evaluateTab('tab-1', tabState, { expression: 'window.location = "http://169.254.169.254/"' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Blocked private network target'),
    });
  });

  test('clickTab surfaces popup-triggered blocked navigations on the opener tab', async () => {
    let routeHandler;
    const pageHandlers = {};
    const popupPage = {
      opener: jest.fn().mockResolvedValue(null),
    };
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn((event, handler) => {
        pageHandlers[event] = handler;
      }),
      locator: jest.fn(() => ({
        click: jest.fn(async () => {
          await routeHandler({
            request: () => ({
              url: () => 'http://169.254.169.254/latest/meta-data',
              isNavigationRequest: () => true,
              frame: () => ({ page: () => popupPage }),
            }),
            continue: jest.fn().mockResolvedValue(undefined),
            abort: jest.fn().mockResolvedValue(undefined),
          });
        }),
      })),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      url: jest.fn(() => 'https://public.example.test/'),
    };
    const tabState = await createTabState(page);
    pageHandlers.popup(popupPage);

    await expect(clickTab('tab-1', tabState, { selector: '#open-popup' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Blocked private network target'),
    });
  });

  test('typeTab surfaces blocked navigations triggered by input handlers as statusCode 400 errors', async () => {
    let routeHandler;
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn(),
      locator: jest.fn(() => ({
        evaluate: jest.fn().mockResolvedValue({ isContentEditable: false, tagName: 'INPUT' }),
        fill: jest.fn(async () => {
          await routeHandler({
            request: () => ({
              url: () => 'http://169.254.169.254/latest/meta-data',
              isNavigationRequest: () => true,
              frame: () => ({ page: () => page }),
            }),
            continue: jest.fn().mockResolvedValue(undefined),
            abort: jest.fn().mockResolvedValue(undefined),
          });
        }),
      })),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const tabState = await createTabState(page);

    await expect(typeTab('tab-1', tabState, { selector: '#search', text: 'secret' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Blocked private network target'),
    });
  });

  test('typeTab does not miss delayed blocked navigations that happen after the initial settle window', async () => {
    jest.useFakeTimers();
    try {
      let routeHandler;
      const trackerState = {
        activeToken: 0,
        pendingCounts: new Map(),
      };
      const context = {
        route: jest.fn(async (_pattern, handler) => {
          routeHandler = handler;
        }),
      };
      const page = {
        context: jest.fn(() => context),
        on: jest.fn(),
        addInitScript: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn(async (fn, arg) => {
          const source = String(fn);
          if (source.includes('installActionTrackerScript')) return undefined;
          if (source.includes('startAction')) {
            trackerState.activeToken = arg;
            return undefined;
          }
          if (source.includes('finishAction')) {
            if (trackerState.activeToken === arg) trackerState.activeToken = 0;
            return undefined;
          }
          if (source.includes('getPendingCount')) {
            return trackerState.pendingCounts.get(arg) || 0;
          }
          if (source.includes('getActiveToken')) {
            return trackerState.activeToken || 0;
          }
          return undefined;
        }),
        locator: jest.fn(() => ({
          evaluate: jest.fn().mockResolvedValue({ isContentEditable: false, tagName: 'INPUT' }),
          fill: jest.fn(async () => {
            const token = trackerState.activeToken;
            if (token) {
              trackerState.pendingCounts.set(token, (trackerState.pendingCounts.get(token) || 0) + 1);
            }
            setTimeout(() => {
              const previousToken = trackerState.activeToken;
              trackerState.activeToken = token;
              void routeHandler({
                request: () => ({
                  url: () => 'http://169.254.169.254/latest/meta-data',
                  isNavigationRequest: () => true,
                  frame: () => ({ page: () => page }),
                }),
                continue: jest.fn().mockResolvedValue(undefined),
                abort: jest.fn().mockResolvedValue(undefined),
              }).finally(() => {
                trackerState.activeToken = previousToken;
              });
              if (!token) return;
              const next = (trackerState.pendingCounts.get(token) || 0) - 1;
              if (next > 0) trackerState.pendingCounts.set(token, next);
              else trackerState.pendingCounts.delete(token);
            }, 700);
          }),
        })),
        waitForTimeout: jest.fn((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      };
      const tabState = await createTabState(page);

      const actionPromise = typeTab('tab-1', tabState, { selector: '#search', text: 'secret' });
      const actionExpectation = expect(actionPromise).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('Blocked private network target'),
      });
      await jest.advanceTimersByTimeAsync(700);

      await actionExpectation;
    } finally {
      jest.useRealTimers();
    }
  });

  test('typeTab does not miss delayed blocked navigations that require async DNS resolution', async () => {
    jest.useFakeTimers();
    try {
      lookupMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([{ address: '127.0.0.1', family: 4 }]), 50)),
      );

      let routeHandler;
      const trackerState = {
        activeToken: 0,
        pendingCounts: new Map(),
      };
      const context = {
        route: jest.fn(async (_pattern, handler) => {
          routeHandler = handler;
        }),
      };
      const page = {
        context: jest.fn(() => context),
        on: jest.fn(),
        addInitScript: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn(async (fn, arg) => {
          const source = String(fn);
          if (source.includes('installActionTrackerScript')) return undefined;
          if (source.includes('startAction')) {
            trackerState.activeToken = arg;
            return undefined;
          }
          if (source.includes('finishAction')) {
            if (trackerState.activeToken === arg) trackerState.activeToken = 0;
            return undefined;
          }
          if (source.includes('getPendingCount')) {
            return trackerState.pendingCounts.get(arg) || 0;
          }
          if (source.includes('getActiveToken')) {
            return trackerState.activeToken || 0;
          }
          return undefined;
        }),
        locator: jest.fn(() => ({
          evaluate: jest.fn().mockResolvedValue({ isContentEditable: false, tagName: 'INPUT' }),
          fill: jest.fn(async () => {
            const token = trackerState.activeToken;
            if (token) {
              trackerState.pendingCounts.set(token, (trackerState.pendingCounts.get(token) || 0) + 1);
            }
            setTimeout(() => {
              const previousToken = trackerState.activeToken;
              trackerState.activeToken = token;
              void routeHandler({
                request: () => ({
                  url: () => 'http://public-looking.example.test/latest/meta-data',
                  isNavigationRequest: () => true,
                  frame: () => ({ page: () => page }),
                }),
                continue: jest.fn().mockResolvedValue(undefined),
                abort: jest.fn().mockResolvedValue(undefined),
              }).finally(() => {
                trackerState.activeToken = previousToken;
              });
              if (!token) return;
              const next = (trackerState.pendingCounts.get(token) || 0) - 1;
              if (next > 0) trackerState.pendingCounts.set(token, next);
              else trackerState.pendingCounts.delete(token);
            }, 700);
          }),
        })),
        waitForTimeout: jest.fn((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      };
      const tabState = await createTabState(page);

      const actionPromise = typeTab('tab-1', tabState, { selector: '#search', text: 'secret' });
      const actionExpectation = expect(actionPromise).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('Blocked private network target'),
      });
      await jest.advanceTimersByTimeAsync(760);

      await actionExpectation;
    } finally {
      jest.useRealTimers();
    }
  });

  test('typeTab does not blame the next action for a stale blocked navigation from background interval work', async () => {
    jest.useFakeTimers();
    try {
      let routeHandler;
      const trackerState = {
        activeToken: 0,
        pendingCounts: new Map(),
      };
      let fillCount = 0;
      const context = {
        route: jest.fn(async (_pattern, handler) => {
          routeHandler = handler;
        }),
      };
      const page = {
        context: jest.fn(() => context),
        on: jest.fn(),
        addInitScript: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn(async (fn, arg) => {
          const source = String(fn);
          if (source.includes('installActionTrackerScript')) return undefined;
          if (source.includes('startAction')) {
            trackerState.activeToken = arg;
            return undefined;
          }
          if (source.includes('finishAction')) {
            if (trackerState.activeToken === arg) trackerState.activeToken = 0;
            return undefined;
          }
          if (source.includes('getPendingCount')) {
            return trackerState.pendingCounts.get(arg) || 0;
          }
          if (source.includes('getActiveToken')) {
            return trackerState.activeToken || 0;
          }
          return undefined;
        }),
        locator: jest.fn(() => ({
          evaluate: jest.fn().mockResolvedValue({ isContentEditable: false, tagName: 'INPUT' }),
          fill: jest.fn(async () => {
            fillCount += 1;
            if (fillCount !== 1) return;
            setTimeout(() => {
              const previousToken = trackerState.activeToken;
              trackerState.activeToken = 1;
              void routeHandler({
                request: () => ({
                  url: () => 'http://169.254.169.254/latest/meta-data',
                  isNavigationRequest: () => true,
                  frame: () => ({ page: () => page }),
                }),
                continue: jest.fn().mockResolvedValue(undefined),
                abort: jest.fn().mockResolvedValue(undefined),
              }).finally(() => {
                trackerState.activeToken = previousToken;
              });
            }, 700);
          }),
        })),
        waitForTimeout: jest.fn((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      };
      const tabState = await createTabState(page);

      const firstAction = typeTab('tab-1', tabState, { selector: '#search', text: 'first' });
      await jest.advanceTimersByTimeAsync(10);
      await expect(firstAction).resolves.toEqual({ ok: true });
      await jest.advanceTimersByTimeAsync(700);

      const secondAction = typeTab('tab-1', tabState, { selector: '#search', text: 'second' });
      await jest.advanceTimersByTimeAsync(10);
      await expect(secondAction).resolves.toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('typeTab does not blame the current action for background interval work that fires during tracker startup', async () => {
    jest.useFakeTimers();
    try {
      let routeHandler;
      const trackerState = {
        activeToken: 0,
        pendingCounts: new Map(),
      };
      const context = {
        route: jest.fn(async (_pattern, handler) => {
          routeHandler = handler;
        }),
      };
      const page = {
        context: jest.fn(() => context),
        on: jest.fn(),
        addInitScript: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn(async (fn, arg) => {
          const source = String(fn);
          if (source.includes('installActionTrackerScript')) return undefined;
          if (source.includes('startAction')) {
            trackerState.activeToken = arg;
            return new Promise((resolve) => {
              setTimeout(() => {
                const previousToken = trackerState.activeToken;
                trackerState.activeToken = 99;
                void routeHandler({
                  request: () => ({
                    url: () => 'http://169.254.169.254/latest/meta-data',
                    isNavigationRequest: () => true,
                    frame: () => ({ page: () => page }),
                  }),
                  continue: jest.fn().mockResolvedValue(undefined),
                  abort: jest.fn().mockResolvedValue(undefined),
                }).finally(() => {
                  trackerState.activeToken = previousToken;
                });
                resolve(undefined);
              }, 50);
            });
          }
          if (source.includes('finishAction')) {
            if (trackerState.activeToken === arg) trackerState.activeToken = 0;
            return undefined;
          }
          if (source.includes('getPendingCount')) {
            return trackerState.pendingCounts.get(arg) || 0;
          }
          if (source.includes('getActiveToken')) {
            return trackerState.activeToken || 0;
          }
          return undefined;
        }),
        locator: jest.fn(() => ({
          evaluate: jest.fn().mockResolvedValue({ isContentEditable: false, tagName: 'INPUT' }),
          fill: jest.fn().mockResolvedValue(undefined),
        })),
        waitForTimeout: jest.fn((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      };
      const tabState = await createTabState(page);

      const actionPromise = typeTab('tab-1', tabState, { selector: '#search', text: 'safe' });
      await jest.advanceTimersByTimeAsync(60);

      await expect(actionPromise).resolves.toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('typeTab does not blame the current action for background interval work that resolves to a blocked host during tracker startup', async () => {
    jest.useFakeTimers();
    try {
      lookupMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([{ address: '127.0.0.1', family: 4 }]), 50)),
      );

      let routeHandler;
      const trackerState = {
        activeToken: 0,
        pendingCounts: new Map(),
      };
      const context = {
        route: jest.fn(async (_pattern, handler) => {
          routeHandler = handler;
        }),
      };
      const page = {
        context: jest.fn(() => context),
        on: jest.fn(),
        addInitScript: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn(async (fn, arg) => {
          const source = String(fn);
          if (source.includes('installActionTrackerScript')) return undefined;
          if (source.includes('startAction')) {
            trackerState.activeToken = arg;
            return new Promise((resolve) => {
              setTimeout(() => {
                const previousToken = trackerState.activeToken;
                trackerState.activeToken = 99;
                void routeHandler({
                  request: () => ({
                    url: () => 'http://public-looking.example.test/latest/meta-data',
                    isNavigationRequest: () => true,
                    frame: () => ({ page: () => page }),
                  }),
                  continue: jest.fn().mockResolvedValue(undefined),
                  abort: jest.fn().mockResolvedValue(undefined),
                }).finally(() => {
                  trackerState.activeToken = previousToken;
                });
                resolve(undefined);
              }, 50);
            });
          }
          if (source.includes('finishAction')) {
            if (trackerState.activeToken === arg) trackerState.activeToken = 0;
            return undefined;
          }
          if (source.includes('getPendingCount')) {
            return trackerState.pendingCounts.get(arg) || 0;
          }
          if (source.includes('getActiveToken')) {
            return trackerState.activeToken || 0;
          }
          return undefined;
        }),
        locator: jest.fn(() => ({
          evaluate: jest.fn().mockResolvedValue({ isContentEditable: false, tagName: 'INPUT' }),
          fill: jest.fn().mockResolvedValue(undefined),
        })),
        waitForTimeout: jest.fn((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      };
      const tabState = await createTabState(page);

      const actionPromise = typeTab('tab-1', tabState, { selector: '#search', text: 'safe' });
      await jest.advanceTimersByTimeAsync(120);

      await expect(actionPromise).resolves.toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('typeTab does not blame the current action for blocked interval work still owned by the previous action', async () => {
    jest.useFakeTimers();
    try {
      let routeHandler;
      const trackerState = {
        activeToken: 0,
        pendingCounts: new Map(),
      };
      let fillCount = 0;
      const context = {
        route: jest.fn(async (_pattern, handler) => {
          routeHandler = handler;
        }),
      };
      const page = {
        context: jest.fn(() => context),
        on: jest.fn(),
        addInitScript: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn(async (fn, arg) => {
          const source = String(fn);
          if (source.includes('installActionTrackerScript')) return undefined;
          if (source.includes('startAction')) {
            trackerState.activeToken = arg;
            return undefined;
          }
          if (source.includes('finishAction')) {
            if (trackerState.activeToken === arg) trackerState.activeToken = 0;
            return undefined;
          }
          if (source.includes('getPendingCount')) {
            return trackerState.pendingCounts.get(arg) || 0;
          }
          if (source.includes('getActiveToken')) {
            return trackerState.activeToken || 0;
          }
          return undefined;
        }),
        locator: jest.fn(() => ({
          evaluate: jest.fn().mockResolvedValue({ isContentEditable: false, tagName: 'INPUT' }),
          fill: jest.fn(() => {
            fillCount += 1;
            if (fillCount === 1) {
              return Promise.resolve();
            }
            return new Promise((resolve) => setTimeout(resolve, 100));
          }),
        })),
        waitForTimeout: jest.fn((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      };
      const tabState = await createTabState(page);

      const firstAction = typeTab('tab-1', tabState, { selector: '#search', text: 'first' });
      await jest.advanceTimersByTimeAsync(10);
      await expect(firstAction).resolves.toEqual({ ok: true });

      const secondAction = typeTab('tab-1', tabState, { selector: '#search', text: 'second' });
      setTimeout(() => {
        const previousToken = trackerState.activeToken;
        trackerState.activeToken = 1;
        void routeHandler({
          request: () => ({
            url: () => 'http://169.254.169.254/latest/meta-data',
            isNavigationRequest: () => true,
            frame: () => ({ page: () => page }),
          }),
          continue: jest.fn().mockResolvedValue(undefined),
          abort: jest.fn().mockResolvedValue(undefined),
        }).finally(() => {
          trackerState.activeToken = previousToken;
        });
      }, 10);

      await jest.advanceTimersByTimeAsync(120);
      await expect(secondAction).resolves.toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('pressTab surfaces blocked navigations triggered by key presses as statusCode 400 errors', async () => {
    let routeHandler;
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn(),
      keyboard: {
        press: jest.fn(async () => {
          await routeHandler({
            request: () => ({
              url: () => 'http://169.254.169.254/latest/meta-data',
              isNavigationRequest: () => true,
              frame: () => ({ page: () => page }),
            }),
            continue: jest.fn().mockResolvedValue(undefined),
            abort: jest.fn().mockResolvedValue(undefined),
          });
        }),
      },
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const tabState = await createTabState(page);

    await expect(pressTab('tab-1', tabState, 'Enter')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Blocked private network target'),
    });
  });

  test('scrollTab surfaces blocked navigations triggered by scroll handlers as statusCode 400 errors', async () => {
    let routeHandler;
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn(),
      mouse: {
        wheel: jest.fn(async () => {
          await routeHandler({
            request: () => ({
              url: () => 'http://169.254.169.254/latest/meta-data',
              isNavigationRequest: () => true,
              frame: () => ({ page: () => page }),
            }),
            continue: jest.fn().mockResolvedValue(undefined),
            abort: jest.fn().mockResolvedValue(undefined),
          });
        }),
      },
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const tabState = await createTabState(page);

    await expect(scrollTab(tabState, { direction: 'down', amount: 200 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Blocked private network target'),
    });
  });

  test('scrollElementTab surfaces blocked navigations triggered by scrollable containers as statusCode 400 errors', async () => {
    let routeHandler;
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const element = {
      evaluate: jest
        .fn()
        .mockImplementationOnce(async () => {
          await routeHandler({
            request: () => ({
              url: () => 'http://169.254.169.254/latest/meta-data',
              isNavigationRequest: () => true,
              frame: () => ({ page: () => page }),
            }),
            continue: jest.fn().mockResolvedValue(undefined),
            abort: jest.fn().mockResolvedValue(undefined),
          });
        })
        .mockResolvedValueOnce({
          scrollTop: 0,
          scrollLeft: 0,
          scrollHeight: 100,
          clientHeight: 50,
          scrollWidth: 100,
          clientWidth: 50,
        }),
    };
    const locator = {
      count: jest.fn().mockResolvedValue(1),
      first: jest.fn(() => element),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn(),
      locator: jest.fn(() => locator),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const tabState = await createTabState(page);

    await expect(scrollElementTab('tab-1', tabState, { selector: '#pane' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Blocked private network target'),
    });
  });

  test('waitForPageReady surfaces blocked navigations discovered during readiness waits as statusCode 400 errors', async () => {
    let routeHandler;
    const context = {
      route: jest.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
    };
    const page = {
      context: jest.fn(() => context),
      on: jest.fn(),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn(async (ms) => {
        if (ms === 200) {
          await routeHandler({
            request: () => ({
              url: () => 'http://169.254.169.254/latest/meta-data',
              isNavigationRequest: () => true,
              frame: () => ({ page: () => page }),
            }),
            continue: jest.fn().mockResolvedValue(undefined),
            abort: jest.fn().mockResolvedValue(undefined),
          });
        }
      }),
    };
    await createTabState(page);

    await expect(waitForPageReady(page, { timeout: 500, waitForNetwork: false })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Blocked private network target'),
    });
  });
});
