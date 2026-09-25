import './runtime';
import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {Socket} from 'node:net';
it('HTTP requests survive macOS socket QoS failures',async()=>{
 const server=createServer((_,res)=>res.end('ok'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const proto=Socket.prototype as any;const original=proto.setTypeOfService;
 proto.setTypeOfService=function(){throw Object.assign(new Error('setTypeOfService EINVAL'),{code:'EINVAL'});};
 try {
  const address=server.address() as {port:number};
  const replies=await Promise.all(Array.from({length:10},async()=> (await fetch(`http://127.0.0.1:${address.port}`)).text()));
  expect(replies).toEqual(Array(10).fill('ok'));
 } finally {proto.setTypeOfService=original;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
