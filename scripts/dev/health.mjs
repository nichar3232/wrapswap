const kind = process.argv[2];
const port = process.env[{api:'API_PORT',crank:'CRANK_HEALTH_PORT',web:'WEB_PORT'}[kind]];
const r = await fetch(`http://127.0.0.1:${port}/${kind === 'api' ? 'health' : kind === 'crank' ? 'status' : ''}`);
if (!r.ok) throw Error(`${kind}: HTTP ${r.status}`);
if (kind !== 'web' && !(await r.json()).ok) throw Error(`${kind}: unhealthy`);
