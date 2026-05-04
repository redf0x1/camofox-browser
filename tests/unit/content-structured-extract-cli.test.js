const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');

function makeContext(postImpl, printed) {
  return {
    getTransport() {
      return {
        post: postImpl,
      };
    },
    print(_command, value) {
      printed.push(value);
    },
    handleError(error) {
      throw error;
    },
    getFormat() {
      return 'json';
    },
  };
}

describe('extract-structured CLI command (unit)', () => {
  let registerContentCommands;

  beforeEach(() => {
    jest.resetModules();
    ({ registerContentCommands } = require('../../dist/src/cli/commands/content'));
  });

  test('posts an inline schema to the core route', async () => {
    const post = jest.fn().mockResolvedValue({ data: { ok: true, data: { title: 'Catalog' } } });
    const printed = [];
    const program = new Command();
    registerContentCommands(program, makeContext(post, printed));

    await program.parseAsync(
      [
        'node',
        'camofox',
        'extract-structured',
        '{"kind":"object","fields":{"title":{"kind":"text","selector":"h1"}}}',
        'tab-1',
        '--user',
        'user-1',
      ],
      { from: 'node' },
    );

    expect(post).toHaveBeenCalledWith('/tabs/tab-1/extract-structured', {
      userId: 'user-1',
      schema: { kind: 'object', fields: { title: { kind: 'text', selector: 'h1' } } },
    });
    expect(printed[0]).toEqual({ ok: true, data: { title: 'Catalog' } });
  });

  test('loads a schema from an @file argument', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-structured-schema-'));
    const schemaPath = path.join(tmpDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify({ kind: 'object', fields: { title: { kind: 'text', selector: 'h1' } } }));

    const post = jest.fn().mockResolvedValue({ data: { ok: true, data: { title: 'Catalog' } } });
    const printed = [];
    const program = new Command();
    registerContentCommands(program, makeContext(post, printed));

    await program.parseAsync(
      ['node', 'camofox', 'extract-structured', `@${schemaPath}`, 'tab-2', '--user', 'user-2'],
      { from: 'node' },
    );

    expect(post).toHaveBeenCalledWith('/tabs/tab-2/extract-structured', {
      userId: 'user-2',
      schema: { kind: 'object', fields: { title: { kind: 'text', selector: 'h1' } } },
    });
  });

  test('surfaces a schema-file-specific error when @file cannot be read', async () => {
    const program = new Command();
    registerContentCommands(program, makeContext(jest.fn(), []));

    await expect(
      program.parseAsync(
        ['node', 'camofox', 'extract-structured', '@/tmp/does-not-exist-structured-schema.json', 'tab-3', '--user', 'user-3'],
        { from: 'node' },
      ),
    ).rejects.toThrow(/Cannot load structured schema from file/);
  });
});
