// Node 24's bundled Undici can crash on macOS setTypeOfService(EINVAL).
// Use the fixed, lockfile-pinned dispatcher without swallowing application errors.
// Upstream: https://github.com/nodejs/undici/pull/5547
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent());
