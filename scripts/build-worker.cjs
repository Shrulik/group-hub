const { build } = require('esbuild');
const path = require('path');

async function run() {
  const entryFile = path.resolve(__dirname, '..', 'src', 'background', 'index.js');
  const outfile = path.resolve(__dirname, '..', 'dist', 'extension', 'background.js');

  await build({
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['chrome120'],
    sourcemap: true,
    logLevel: 'info'
  });
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
