import fs from 'node:fs';

const latestTag = process.argv[2] || '';
const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(latestTag);
if (!match) throw new Error(`Invalid latest version tag: ${latestTag || '(missing)'}`);

const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
const writeJson = (path, update) => {
  const value = JSON.parse(fs.readFileSync(path, 'utf8'));
  update(value);
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const replaceOne = (path, pattern, replacement) => {
  const source = fs.readFileSync(path, 'utf8');
  const updated = source.replace(pattern, replacement);
  if (updated === source) throw new Error(`Version field not found in ${path}`);
  fs.writeFileSync(path, updated);
};

writeJson('package.json', value => { value.version = version; });
writeJson('package-lock.json', value => {
  value.version = version;
  value.packages[''].version = version;
});
writeJson('src-tauri/tauri.conf.json', value => { value.version = version; });
replaceOne(
  'src-tauri/Cargo.toml',
  /(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/,
  `$1${version}$2`,
);
replaceOne(
  'src-tauri/Cargo.lock',
  /(\[\[package\]\]\nname = "codex-pulse"\nversion = ")[^"]+("\n)/,
  `$1${version}$2`,
);

process.stdout.write(version);
