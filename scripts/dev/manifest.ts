import { readFileSync } from 'node:fs';
import { parseDeployment } from '@wrapswap/types';
parseDeployment(JSON.parse(readFileSync(`deployments/${process.env.NETWORK}.json`, 'utf8')));
