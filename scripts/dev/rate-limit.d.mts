import type { IncomingMessage, ServerResponse } from 'node:http';
export function clientIp(req: IncomingMessage): string;
export function createLimiter(limit?: number): (req: IncomingMessage, res: ServerResponse) => boolean;
