#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const distDir = path.join(rootDir, 'dist');

const requiredFilesToCopy = [
  ['README.md', 'README.md'],
  ['analyze.js', 'analyze.js'],
  ['dashboard.js', 'dashboard.js'],
  ['monitor.js', 'monitor.js'],
  ['verify.js', 'verify.js'],
  ['config.json', 'config.json'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['staticwebapp.config.json', 'staticwebapp.config.json'],
  ['public/index.html', 'index.html'],
  ['public/index.html', 'public/index.html'],
  ['public/openexa_logo.webp', 'openexa_logo.webp'],
  ['public/openexa_logo.webp', 'public/openexa_logo.webp'],
  ['lib/utils.js', 'lib/utils.js'],
  ['lib/discord.js', 'lib/discord.js'],
];

const optionalFilesToCopy = [
  ['DEPLOYMENT.md', 'DEPLOYMENT.md'],
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(fromRelativePath, toRelativePath) {
  const sourcePath = path.join(rootDir, fromRelativePath);
  const targetPath = path.join(distDir, toRelativePath);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing required build input: ${fromRelativePath}`);
  }

  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function copyFileIfPresent(fromRelativePath, toRelativePath) {
  const sourcePath = path.join(rootDir, fromRelativePath);
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  const targetPath = path.join(distDir, toRelativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function cleanDist() {
  fs.rmSync(distDir, { recursive: true, force: true });
  ensureDir(distDir);
}

function writeEnvExample() {
  const envExample = [
    'DEPLOYMENT_TOKEN=your_static_web_apps_deployment_token',
    'DISCORD_TOKEN=your_discord_bot_token_here',
    'DISCORD_USER_ID=your_discord_user_id_here',
    'DISCORD_GUILD_ID=your_discord_guild_id_here',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(distDir, '.env.example'), envExample);
}

function verifyDistManifest() {
  const requiredDistFiles = [
    'index.html',
    'public/index.html',
    'openexa_logo.webp',
    'public/openexa_logo.webp',
    'staticwebapp.config.json',
    'config.json',
    'dashboard.js',
    'monitor.js',
    'analyze.js',
    'verify.js',
    'lib/utils.js',
    'lib/discord.js',
    'package.json',
    'package-lock.json',
    '.env.example',
  ];

  const missing = requiredDistFiles.filter((relativePath) => {
    const fullPath = path.join(distDir, relativePath);
    return !fs.existsSync(fullPath);
  });

  if (missing.length > 0) {
    throw new Error(`Build output is missing required files: ${missing.join(', ')}`);
  }
}

function main() {
  cleanDist();

  for (const [fromRelativePath, toRelativePath] of requiredFilesToCopy) {
    copyFile(fromRelativePath, toRelativePath);
  }

  for (const [fromRelativePath, toRelativePath] of optionalFilesToCopy) {
    copyFileIfPresent(fromRelativePath, toRelativePath);
  }

  writeEnvExample();
  verifyDistManifest();
  console.log(`Built dist at ${distDir}`);
}

main();