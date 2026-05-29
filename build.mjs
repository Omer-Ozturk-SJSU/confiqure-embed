import { build } from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [resolve(__dirname, 'src/index.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'confiqure',
  target: 'es2020',
  outfile: resolve(__dirname, '../frontend/public/embed.js'),
  banner: { js: '/* confiqure.ai embed SDK — https://confiqure.ai/docs/guides/embed */' }
})

console.log('Built frontend/public/embed.js')
