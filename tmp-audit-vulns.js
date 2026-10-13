const { runtimePackages, excludedPackages } = require('./scripts/check-dead-deps.cjs');
const VULNS = ['constantinople','jade','proxy-addr','uglify-js','basic-ftp','body-parser','express','get-uri','NeteaseCloudMusicApi','node-forge','pac-proxy-agent','path-to-regexp','qs','transformers','moment','music-metadata','qq-music-api','useragent','clean-css','cookie','send','serve-static'];
const { loaded, staticRefs } = runtimePackages();
const ref = new Set([...loaded, ...staticRefs]);
const excluded = excludedPackages();
console.log('runtime=' + loaded.size + ' static=' + staticRefs.size + ' excluded=' + excluded.size + '\n');
const reach = [], unreach = [];
for (const v of VULNS) {
  const hit = ref.has(v);
  const src = hit ? (loaded.has(v) ? 'load' : 'static') : '-';
  const ex = excluded.has(v) ? ' +excluded' : '';
  console.log(v.padEnd(24) + (hit ? 'REACHABLE' : 'unreachable').padEnd(12) + src + ex);
  (hit ? reach : unreach).push(v);
}
console.log('\nreachable ' + reach.length + ': ' + (reach.join(', ') || 'none'));
console.log('unreachable ' + unreach.length);
console.log('unreachable & excluded: ' + unreach.filter(function(p){return excluded.has(p);}).join(', '));