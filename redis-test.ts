import 'dotenv/config';
import Redis from 'ioredis';

console.log('REDIS_URL =', process.env.REDIS_URL);

const redis = new Redis(process.env.REDIS_URL!);

redis.on('connect', () => {
  console.log('CONNECTED');
});

redis.on('error', (err) => {
  console.error(err);
});

(async () => {
  console.log(await redis.ping());
  await redis.quit();
})();