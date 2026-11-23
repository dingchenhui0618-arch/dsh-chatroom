// Tiny Kimi WebBridge helper.
//   node wb.mjs <session> eval  '<js>'
//   node wb.mjs <session> click '<text>'      real mouse click on first button/a containing text
//   node wb.mjs <session> shot  [name]
// Prints JSON result; for shot prints the saved png path.
const SESSION = process.argv[2];
const CMD = process.argv[3];
const ARG = process.argv[4] || '';

async function call(action, args) {
  const res = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args, session: SESSION }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(JSON.stringify(json.error));
  return json.data;
}

if (CMD === 'eval') {
  const d = await call('evaluate', { code: ARG });
  console.log(typeof d.value === 'string' ? d.value : JSON.stringify(d, null, 2));
} else if (CMD === 'click') {
  const needle = JSON.stringify(ARG);
  const code = `(() => {
    const nodes = [...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')];
    const el = nodes.find(n => (n.innerText || n.value || '').includes(${needle}));
    if (!el) return JSON.stringify({ found: false });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height, text: (el.innerText||'').trim().slice(0,40) });
  })()`;
  const d = await call('evaluate', { code });
  const info = JSON.parse(d.value);
  if (!info.found) {
    console.log(JSON.stringify({ clicked: false, info }));
    process.exit(3);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call('cdp', { method: 'Input.dispatchMouseEvent', params: { type, x: info.x, y: info.y, button: 'left', clickCount: 1 } });
  }
  console.log(JSON.stringify({ clicked: true, info }));
} else if (CMD === 'net') {
  const d = await call('network', { cmd: ARG || 'list' });
  console.log(JSON.stringify(d, null, 2).slice(0, 6000));
} else if (CMD === 'shot') {
  const d = await call('screenshot', {});
  console.log(d.path);
} else {
  console.error('usage: wb.mjs <session> eval|click|shot <arg>');
  process.exit(2);
}
