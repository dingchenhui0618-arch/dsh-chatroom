import fs from 'node:fs';

const target = 'lib/client.js';
let src = fs.readFileSync(target, 'utf8');
const b64 = fs.readFileSync('design/mcp/whale-mask.txt', 'utf8').trim();
let block = fs.readFileSync('design/mcp/library-port.css', 'utf8')
  .replace('WHALE_B64', b64)
  .replace(/\s+$/, '');

const anchor = "    ].join('\\n')";
const at = src.lastIndexOf(anchor);
if (at < 0) throw new Error('anchor not found');
if (src.includes('--cr-whale')) {
  console.log('already injected, aborting');
  process.exit(0);
}
src = src.slice(0, at) + block + '\n' + src.slice(at);
fs.writeFileSync(target, src);
console.log('inserted at', at, 'block bytes', block.length);
