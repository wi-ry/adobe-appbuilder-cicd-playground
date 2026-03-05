const actionWebInvoke = require('../src/dx-excshell-1/web-src/src/utils.js').default;

describe('actionWebInvoke', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should handle POST request with object params', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"result": "success"}'),
    });

    const result = await actionWebInvoke('http://example.com', {}, { key: 'value' }, { method: 'POST' });

    expect(global.fetch).toHaveBeenCalledWith('http://example.com', expect.objectContaining({
      method: 'POST',
      body: '{"key":"value"}', // This should fail with the bug, since body is set to params instead of JSON.stringify(params)
    }));
    expect(result).toEqual({ result: 'success' });
  });
});