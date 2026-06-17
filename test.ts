import Redis from 'ioredis';
import fs from 'fs';

console.log('cwd=', process.cwd());
console.log('.env exists=', fs.existsSync('.env'));
console.log('.env root exists=', fs.existsSync('../.env'));
console.log('REDIS_URL=', process.env.REDIS_URL);

const redis = new Redis(process.env.REDIS_URL!, {
  connectTimeout: 10000,
});

redis.on('connect', () => {
  console.log('CONNECTED');
});

redis.on('ready', () => {
  console.log('READY');
});

redis.on('error', (err) => {
  console.error('ERROR =', err);
});

(async () => {
  try {
    const pong = await redis.ping();
    console.log('PING =', pong);
  } catch (e) {
    console.error('CATCH =', e);
  } finally {
    await redis.quit();
  }
})();