function makeMockPage({ extractionResult, blobResult } = {}) {
  const evaluate = jest.fn(async (_fn, arg) => {
    if (arg && Array.isArray(arg.requestedTypes)) {
      return extractionResult;
    }
    return blobResult;
  });

  return {
    evaluate,
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
  };
}

describe('resource-extractor images (unit)', () => {
  /** @type {(page:any, params:any) => Promise<any>} */
  let extractImages;

  beforeEach(() => {
    jest.resetModules();
    ({ extractImages } = require('../../dist/src/services/resource-extractor'));
  });

  test('extractImages() requests only image resources', async () => {
    const page = makeMockPage({
      extractionResult: {
        ok: true,
        container: { selector: '#gallery', tagName: 'section', childCount: 2 },
        resources: {
          images: [
            {
              url: 'https://example.com/hero.png',
              filename: 'hero.png',
              mimeType: 'image/png',
              tagName: 'IMG',
              type: 'image',
              alt: 'Hero image',
              width: 640,
              height: 480,
              isBlob: false,
              isDataUri: false,
              hasDownloadAttr: false,
              text: null,
              ref: null,
              parentSelector: 'section',
            },
          ],
          links: [],
          media: [],
          documents: [],
        },
        metadata: { blobs: [] },
      },
    });

    const result = await extractImages(page, {
      selector: '#gallery',
      extensions: ['png'],
      triggerLazyLoad: false,
    });

    expect(page.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        selector: '#gallery',
        requestedTypes: ['images'],
        extFilters: ['.png'],
      }),
    );
    expect(result.resources.images).toHaveLength(1);
    expect(result.resources.links).toEqual([]);
    expect(result.resources.media).toEqual([]);
    expect(result.resources.documents).toEqual([]);
    expect(result.totals).toEqual({
      images: 1,
      links: 0,
      media: 0,
      documents: 0,
      total: 1,
    });
  });

  test('extractImages() resolves blob URLs when requested', async () => {
    const page = makeMockPage({
      extractionResult: {
        ok: true,
        container: { selector: 'body', tagName: 'body', childCount: 1 },
        resources: {
          images: [
            {
              url: 'blob:https://example.com/blob-1',
              filename: null,
              mimeType: null,
              tagName: 'IMG',
              type: 'image',
              alt: 'Blob image',
              width: null,
              height: null,
              isBlob: true,
              isDataUri: false,
              hasDownloadAttr: false,
              text: null,
              ref: null,
              parentSelector: 'div',
            },
          ],
          links: [],
          media: [],
          documents: [],
        },
        metadata: { blobs: ['blob:https://example.com/blob-1'] },
      },
      blobResult: {
        dataUrl: 'data:image/png;base64,Y2Ftb2ZveA==',
        mimeType: 'image/png',
      },
    });

    const result = await extractImages(page, {
      resolveBlobs: true,
    });

    expect(result.resources.images[0]).toEqual(
      expect.objectContaining({
        url: 'data:image/png;base64,Y2Ftb2ZveA==',
        mimeType: 'image/png',
        isBlob: false,
        isDataUri: true,
      }),
    );
    expect(result.metadata.blobsResolved).toBe(1);
  });
});
