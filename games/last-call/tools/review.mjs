// Run one round of the visual review loop.
//
//   node tools/review.mjs <runName> [previousRunName]
//
// Captures the scripted shot list, then, when a previous run is given, builds
// a blind A/B composite per beat with the left/right order randomised and the
// key written to a file the judge is never shown. The point of the blindfold
// is not ceremony: a reviewer who knows which build is "the new one" will find
// reasons to prefer it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const run = process.argv[2] || 'run';
const prev = process.argv[3] || null;
const port = process.env.PORT || '5199';
const quality = process.env.QUALITY || 'medium';
const W = process.env.W || '1280', H = process.env.H || '720';

const shotDir = join('REVIEW/shots', run);
const outDir = join('REVIEW', run);
mkdirSync(outDir, { recursive: true });

const sh = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  return (r.stdout || '') + (r.stderr || '');
};

console.log(`capturing ${run} at ${W}x${H}, quality=${quality}`);
const log = sh('node', ['tools/shotlist.mjs', shotDir, run, W, H], { PORT: port, QUALITY: quality });
const errCount = (log.match(/\[pageerror\]/g) || []).length;
console.log(log.split('--- ERRORS')[1] ? '--- ERRORS' + log.split('--- ERRORS')[1].slice(0, 900) : '(no error section)');

const shots = existsSync(shotDir) ? readdirSync(shotDir).filter((f) => f.endsWith('.png')).sort() : [];
if (!shots.length) { console.error('no shots captured, aborting'); process.exit(1); }

// Luminance statistics catch the failure modes that are boring to eyeball:
// a frame crushed to black, a frame blown to white, a frame with no midtones.
const stats = sh('node', ['tools/imgstats.mjs', ...shots.map((f) => join(shotDir, f))]);
console.log(stats);

const pairs = [];
if (prev) {
  const prevDir = join('REVIEW/shots', prev);
  for (const f of shots) {
    const beat = f.replace(`${run}-`, '');
    const prevFile = join(prevDir, `${prev}-${beat}`);
    if (!existsSync(prevFile)) continue;
    const out = join(outDir, `ab-${beat}`);
    const key = join(outDir, `key-${beat}.json`);
    sh('node', ['tools/compare.mjs', prevFile, join(shotDir, f), out, key]);
    pairs.push({ beat, composite: out, key });
  }
}

const packet = `# Visual review packet: ${run}

Captured at ${W}x${H}, quality preset \`${quality}\`.
Page errors during capture: **${errCount}** (any non-zero is a hard fail).

## Score these frames against REVIEW/RUBRIC.md

${shots.map((f) => `- \`${join(shotDir, f)}\``).join('\n')}

## Luminance statistics

\`\`\`
${stats.trim()}
\`\`\`

${pairs.length ? `## Blind A/B composites

Each image places two builds side by side, labelled A and B, in a randomised
order. Say which side is better and why BEFORE anyone tells you which is which.
Do not open the key files.

${pairs.map((p) => `- \`${p.composite}\``).join('\n')}
` : '## Blind A/B\n\nNo previous run supplied, so there is nothing to compare against yet.\n'}
`;
writeFileSync(join(outDir, 'PACKET.md'), packet);
console.log(`\npacket written to ${join(outDir, 'PACKET.md')}`);
console.log(`pageerrors=${errCount} shots=${shots.length} composites=${pairs.length}`);
