const autocannon = require('autocannon');
const url = process.env.LOAD_URL || 'http://localhost:3000/login';
autocannon({ url, connections: 50, duration: 15 }, (err, result) => {
  if (err) throw err;
  console.log('Requests/sec:', result.requests.average);
  console.log('Latency avg:', result.latency.average, 'ms');
});
