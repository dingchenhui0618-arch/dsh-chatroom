// Minimal Streamable-HTTP MCP client for the uiX library (光际素材库).
// Usage:
//   node mcp.mjs tools
//   node mcp.mjs call <toolName> '<jsonArgs>'
//   node mcp.mjs call <toolName> @path\to\args.json
// Token comes from env UIX_MCP_TOKEN (raw key, no "Bearer " prefix).
import fs from 'node:fs';

const BASE = 'https://site.txbai.com/api/auth.php?action=mcp';
const TOKEN = process.env.UIX_MCP_TOKEN || '';
if (!TOKEN) {
  console.error('UIX_MCP_TOKEN missing');
  process.exit(2);
}

let sessionId = null;
let seq = 1;

function parseSse(text) {
  const chunks = [];
  let buf = '';
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') {
      if (buf) chunks.push(buf);
      buf = '';
      continue;
    }
    if (rawLine.startsWith('data:')) buf += rawLine.slice(5).trimStart();
  }
  if (buf) chunks.push(buf);
  return chunks
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    })
    .flat();
}

async function post(body) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${ct}\n${text.slice(0, 800)}`);
  }
  if (ct.includes('text/event-stream')) return parseSse(text);
  if (!text.trim()) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    return [text];
  }
}

async function rpc(method, params) {
  const id = seq++;
  const out = await post({ jsonrpc: '2.0', id, method, params });
  const hit = out.find((m) => m && typeof m === 'object' && m.id === id);
  if (!hit) throw new Error(`no response for ${method}: ${JSON.stringify(out).slice(0, 600)}`);
  if (hit.error) throw new Error(`${method} error: ${JSON.stringify(hit.error)}`);
  return hit.result;
}

async function notify(method, params) {
  await post({ jsonrpc: '2.0', method, params });
}

async function init() {
  const res = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-chatroom', version: '1.0.0' },
  });
  await notify('notifications/initialized', {});
  return res;
}

const [cmd, arg1, arg2] = process.argv.slice(2);

try {
  const info = await init();
  if (cmd === 'tools') {
    const list = await rpc('tools/list', {});
    console.log(JSON.stringify({ server: info.serverInfo, protocolVersion: info.protocolVersion, count: (list.tools || []).length }, null, 2));
    for (const t of list.tools || []) {
      console.log(`\n### ${t.name}`);
      console.log((t.description || '').trim());
      const schema = t.inputSchema;
      if (schema && schema.properties) {
        console.log('args: ' + Object.keys(schema.properties).join(', '));
      }
    }
  } else if (cmd === 'schema') {
    const list = await rpc('tools/list', {});
    const t = (list.tools || []).find((x) => x.name === arg1);
    console.log(JSON.stringify(t || null, null, 2));
  } else if (cmd === 'find') {
    const queries = (arg1 || 'chat').split('|');
    const limit = Number(arg2 || 12);
    const seen = new Map();
    for (const q of queries) {
      for (let off = 0; off < 3; off++) {
        const r = await rpc('tools/call', { name: 'search_assets', arguments: { query: q, offset: off * limit, limit } });
        const payload = JSON.parse(r.content[0].text);
        for (const it of payload.items || []) seen.set(it.id, it);
        if (!payload.nextOffset) break;
      }
    }
    for (const it of seen.values()) {
      console.log([it.id, it.library, it.name, it.description, it.free ? 'free' : 'locked'].join(' | '));
    }
    console.log(`\ntotal unique: ${seen.size}`);
  } else if (cmd === 'collect') {
    const [reqId, idxRaw, outFile] = [arg1, process.argv[4], process.argv[5]];
    const r = await rpc('tools/call', { name: 'collect_asset', arguments: { request: reqId, index: Number(idxRaw || 0) } });
    const text = (r.content || []).map((c) => c.text || '').join('\n');
    if (outFile) fs.writeFileSync(outFile, text, 'utf8');
    console.log(JSON.stringify({ isError: !!r.isError, bytes: text.length, out: outFile || null, head: text.slice(0, 400) }, null, 2));
  } else if (cmd === 'call') {
    let args = {};
    if (arg2) {
      args = arg2.startsWith('@') ? JSON.parse(fs.readFileSync(arg2.slice(1), 'utf8')) : JSON.parse(arg2);
    }
    const r = await rpc('tools/call', { name: arg1, arguments: args });
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('usage: node mcp.mjs tools | schema <tool> | call <tool> <json|@file>');
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
