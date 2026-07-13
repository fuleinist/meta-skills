#!/usr/bin/env node

/**
 * meta-skills v1.2 — CLI Entry Point
 *
 * Unified CLI that ties all modules together via direct imports.
 *
 * Usage:
 *   meta-skills init --global          # Scan global skill dirs → global.json
 *   meta-skills init --local           # Scan project → project.json
 *   meta-skills record <skill-id>      # Record skill activation
 *   meta-skills aggregate              # Aggregate usage logs
 *   meta-skills improve                # Self-improvement loop
 *   meta-skills maintain               # Full maintenance run
 *   meta-skills validate <file>        # Validate against schema
 *   meta-skills status                 # Show index summary
 *   meta-skills status --json          # Show index summary as JSON
 *   meta-skills sync push|pull|status  # Cross-agent sync (v1.1)
 *   meta-skills search <query>         # Search marketplace registries (v1.2)
 *   meta-skills install <skill-id>     # Install a marketplace skill (v1.2)
 *   meta-skills marketplace <sub>      # Raw marketplace subcommand
 *   meta-skills dashboard [--port 7777] # Local web dashboard (v1.4)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

// Î“Ã¶Ã‡Î“Ã¶Ã‡ Import all modules directly (no execSync) Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡

let _scanner, _projectScanner, _tracker, _improver, _maintainer, _validator, _syncer, _marketplace, _failureAnalyzer, _dashboard, _agentConfig;

async function ensureModules() {
  if (!_scanner) {
    const [scannerMod, projectMod, trackerMod, improveMod, maintMod, validMod, syncMod, mpMod, faMod, dashMod, acMod] = await Promise.all([
      import(pathToFileURL(path.resolve(__dirname, 'global-scanner.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'project-scanner.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'usage-tracker.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'self-improve.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'maintenance.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'validate.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'sync.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'marketplace.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'failure-analyzer.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'dashboard.mjs')).href),
      import(pathToFileURL(path.resolve(__dirname, 'agent-config.mjs')).href),
    ]);
    _scanner = scannerMod;
    _projectScanner = projectMod;
    _tracker = trackerMod;
    _improver = improveMod;
    _maintainer = maintMod;
    _validator = validMod;
    _syncer = syncMod;
    _marketplace = mpMod;
    _failureAnalyzer = faMod;
    _dashboard = dashMod;
    _agentConfig = acMod;
  }
}

// Î“Ã¶Ã‡Î“Ã¶Ã‡ Commands Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡

async function cmdInit(args) {
  const isGlobal = args.includes('--global');
  const isLocal = args.includes('--local');

  if (isGlobal) {
    await ensureModules();
    const outIdx = args.indexOf('--out');
    const outPath = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
    const dirsIdx = args.indexOf('--dirs');
    const dirs = dirsIdx >= 0 ? args[dirsIdx + 1].split(',').map(s => s.trim()) : null;

    const scanDirs = dirs || _scanner.DEFAULT_DIRS;
    const allEntries = [];
    for (const dir of scanDirs) {
      const found = _scanner.scanDir(dir);
      allEntries.push(...found);
    }
    const merged = _scanner.mergeEntries(allEntries);

    const outputPath = outPath || path.join(os.homedir(), '.meta-skills', 'global.json');
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const output = {
      $schema: _scanner.SCHEMA_URL,
      version: '1.0',
      generated: new Date().toISOString(),
      source: 'global',
      skills: merged,
      stale: [],
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
    console.log(`Î“Â£Ã´ global.json written to ${outputPath}`);
    console.log(`  ${merged.length} skills found`);
  }

  if (isLocal) {
    await ensureModules();
    const projectDir = process.cwd();
    const readme = _projectScanner.readIfExists(path.join(projectDir, 'README.md'));
    const projectName = readme
      ? (readme.match(/^#\s+(.+)/m)?.[1]?.trim() || path.basename(projectDir))
      : path.basename(projectDir);

    const outputPath = path.join(projectDir, '.meta-skills', 'project.json');
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const output = {
      $schema: 'https://meta-skills.dev/schema/v1.json',
      version: '1.0',
      generated: new Date().toISOString(),
      source: 'project',
      project_context: {
        name: projectName,
        tech_stack: _projectScanner.detectTechStack(projectDir),
        key_files: _projectScanner.detectKeyFiles(projectDir),
        patterns: _projectScanner.detectPatterns(readme),
      },
      skills: _projectScanner.scanLocalSkills(projectDir),
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
    console.log(`Î“Â£Ã´ project.json written to ${outputPath}`);
    console.log(`  project: ${projectName}`);
  }
}

async function cmdRecord(args) {
  await ensureModules();
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outcome' && i + 1 < args.length) options.outcome = args[++i];
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
    else if (!options.skillId) options.skillId = args[i];
  }
  if (!options.skillId) { console.error('Î“Â£Ã¹ missing skill-id'); process.exit(1); }
  _tracker.cmdRecord(options.skillId, options);
}

async function cmdAggregate(args) {
  await ensureModules();
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
    else if (args[i] === '--out' && i + 1 < args.length) options.out = path.resolve(args[++i]);
  }
  _tracker.cmdAggregate(options);
}

async function cmdImprove(args) {
  await ensureModules();
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--out' && i + 1 < args.length) options.out = path.resolve(args[++i]);
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
    else if (args[i] === '--dry-run') options.dryRun = true;
  }
  _improver.main(options);
}

async function cmdMaintain(args) {
  await ensureModules();
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-dir' && i + 1 < args.length) options.projectDir = path.resolve(args[++i]);
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--from-failures') options.fromFailures = true;
  }
  _maintainer.main(options);
  if (options.fromFailures) {
    console.log('');
    _failureAnalyzer.analyzeFailures({ sinceDays: 7, dryRun: options.dryRun });
  }
}

async function cmdValidate(args) {
  await ensureModules();
  const files = [];
  let schemaPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--schema' && i + 1 < args.length) schemaPath = path.resolve(args[++i]);
    else files.push(path.resolve(args[i]));
  }
  _validator.main({ files, schemaPath });
}

async function cmdSync(args) {
  await ensureModules();
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sync-dir' && i + 1 < args.length) options.syncDir = path.resolve(args[++i]);
    else if (args[i] === '--log-dir' && i + 1 < args.length) options.logDir = path.resolve(args[++i]);
    else if (args[i] === '--global-json' && i + 1 < args.length) options.globalJson = path.resolve(args[++i]);
    else if (args[i] === '--out' && i + 1 < args.length) options.out = path.resolve(args[++i]);
  }

  // First arg is subcommand: push | pull | sync | status
  const subcommand = args[0];

  switch (subcommand) {
    case 'push':
      _syncer.cmdPush(options);
      break;
    case 'pull':
      _syncer.cmdPull(options);
      break;
    case 'sync':
      _syncer.cmdSync(options);
      break;
    case 'status':
      _syncer.cmdStatus(options);
      break;
    default:
      // No subcommand Î“Ã¥Ã† combined push + pull
      _syncer.cmdSync(options);
  }
}

function cmdStatus(args) {
  const asJson = args.includes('--json');
  const globalPath = path.join(os.homedir(), '.meta-skills', 'global.json');
  if (!fs.existsSync(globalPath)) {
    if (asJson) {
      console.log(JSON.stringify({ error: 'no global.json found', hint: 'Run `meta-skills init --global` first.' }));
    } else {
      console.log('meta-skills: no global.json found. Run `meta-skills init --global` first.');
    }
    return;
  }
  const index = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
  const active = index.skills.length;
  const stale = (index.stale || []).length;
  const high = index.skills.filter(s => s.priority === 'high').length;
  const medium = index.skills.filter(s => s.priority === 'medium').length;
  const low = index.skills.filter(s => s.priority === 'low').length;
  const totalUsage = index.skills.reduce((sum, s) => sum + (s.usage_count || 0), 0);
  const bundles = (index.suggested_bundles || []).length;

  if (asJson) {
    console.log(JSON.stringify({
      version: PKG.version,
      skills: { active, stale, high, medium, low },
      totalActivations: totalUsage,
      suggestedBundles: bundles,
      generated: index.generated,
    }, null, 2));
  } else {
    console.log(`meta-skills v${PKG.version}`);
    console.log(`  Skills: ${active} active, ${stale} stale`);
    console.log(`  Priority: ${high} high, ${medium} medium, ${low} low`);
    console.log(`  Total activations: ${totalUsage}`);
    if (bundles > 0) console.log(`  Suggested bundles: ${bundles}`);
    console.log(`  Generated: ${index.generated}`);
  }
}

async function cmdSearch(args) {
  await ensureModules();
  // Forward to the marketplace module's cmdSearch. Strip any leading
  // 'search' so the marketplace module sees the query as args[0].
  await _marketplace.cmdSearch(args);
}

async function cmdInstall(args) {
  await ensureModules();
  await _marketplace.cmdInstall(args);
}

async function cmdPropose(args) {
  await ensureModules();
  await _failureAnalyzer.cmdPropose(args);
}

async function cmdMarketplace(args) {
  await ensureModules();
  // Top-level marketplace passthrough. Subcommand is args[0].
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'search':  await _marketplace.cmdSearch(rest); break;
    case 'install': await _marketplace.cmdInstall(rest); break;
    case 'list':    await _marketplace.cmdList(rest); break;
    case 'refresh': await _marketplace.cmdRefresh(rest); break;
    default:
      console.error(`unknown marketplace subcommand: ${sub || '(none)'}`);
      console.error('  usage: meta-skills marketplace <search|install|list|refresh>');
      process.exit(1);
  }
}

async function cmdDashboard(args) {
  await ensureModules();
  await _dashboard.cmdDashboard(args);
}

async function cmdAgentConfig(args) {
  await ensureModules();
  const targetDir = process.cwd();
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const sub = args[0];

  switch (sub) {
    case 'inject': {
      const results = _agentConfig.injectAll(targetDir, { dryRun, force });
      if (results.length === 0) {
        console.log('agent-config: no supported config files found');
      } else {
        console.log(`agent-config: injected block into ${results.length} file(s)`);
        for (const r of results) {
          console.log(`  - ${r.action}: ${r.path}${r.error ? ` (${r.error})` : ''}`);
        }
      }
      break;
    }
    case 'remove': {
      const specs = _agentConfig.defaultConfigSpecs(targetDir);
      const found = _agentConfig.detectConfigs(specs);
      let count = 0;
      for (const { spec } of found) {
        const r = _agentConfig.removeBlock(spec, { dryRun });
        count++;
        console.log(`  - ${r.action}: ${spec.name} (${spec.file})${r.error ? ` — ${r.error}` : ''}`);
      }
      if (count === 0) {
        console.log('agent-config: no supported config files found');
      }
      break;
    }
    default: {
      // detect (default)
      const specs = _agentConfig.defaultConfigSpecs(targetDir);
      const found = _agentConfig.detectConfigs(specs);
      if (found.length === 0) {
        console.log('agent-config: no supported config files found');
      } else {
        console.log(`agent-config: found ${found.length} config file(s)`);
        for (const { spec } of found) {
          const parsed = _agentConfig.parseForBlock(spec);
          const flag = parsed.hasBlock ? 'has block' : (parsed.error ? `error: ${parsed.error}` : 'no block');
          console.log(`  - ${spec.name} (${spec.file}) — ${flag}`);
        }
      }
    }
  }
}

function showHelp() {
  console.log(`meta-skills v${PKG.version} — Agent Skill Index`);
  console.log('');
  console.log('Usage:');
  console.log('  meta-skills <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  init --global              Scan global skill directories → global.json');
  console.log('  init --local               Scan project for context → project.json');
  console.log('  record <skill-id>          Record a skill activation');
  console.log('  aggregate                  Aggregate usage logs into index');
  console.log('  improve                    Self-improvement loop (promote/demote)');
  console.log('  maintain                   Full maintenance run (scan + aggregate + improve)');
  console.log('  maintain --from-failures   Include failure analysis in maintenance run');
  console.log('  validate <file>            Validate a meta-skills JSON file');
  console.log('  propose [--since <days>]   Analyze failures and generate improvement proposals (v1.3)');
  console.log('  propose list               List pending proposals');
  console.log('  propose apply <id>         View a proposal');
  console.log('  propose reject <id>        Delete a proposal');
  console.log('  propose auto-pr <id>       File a PR via gh CLI with the proposed patch');
  console.log('  status                     Show index summary');
  console.log('  status --json              Show index summary as JSON');
  console.log('  sync push                  Push local logs to shared sync store');
  console.log('  sync pull                  Pull aggregated data from sync store');
  console.log('  sync                       Push then pull (combined sync)');
  console.log('  sync status                Show per-agent contribution summary');
  console.log('  search <query>             Search marketplace registries (awesome-agent-skills, agentskills.io)');
  console.log('  install <skill-id>         Install a marketplace skill (writes SKILL.md, registers in global.json)');
  console.log('  marketplace <sub>          Raw marketplace passthrough (search|install|list|refresh)');
  console.log('  dashboard [--port 7777]    Local web dashboard (v1.4) — open http://127.0.0.1:7777');
  console.log('  agent-config <detect|inject|remove>  Agent config injection (v1.5)');
  console.log('');
  console.log('Options:');
  console.log('  --help                     Show this help message');
  console.log('  --version                  Show version number');
  console.log('  --dry-run                  Preview changes without writing');
  console.log('  --out <path>               Custom output path');
  console.log('  --log-dir <path>           Custom log directory');
  console.log('  --global-json <path>       Custom global.json path');
  console.log('  --dirs <dir1,dir2,...>     Custom skill directories to scan');
  console.log('  --project-dir <path>       Custom project directory');
  console.log('  --schema <path>            Custom schema file (for validate)');
  console.log('  --outcome success|failure  Outcome of skill activation (for record)');
  console.log('  --sync-dir <path>          Shared sync directory (for sync commands)');
  console.log('  --source <name>            Restrict to a marketplace source (search/list)');
  console.log('  --limit <n>                Max results for search/list (default 20/100)');
  console.log('  --refresh                  Force re-fetch of marketplace caches');
  console.log('  --target <dir>             Install directory (for install; default ~/.meta-skills/installed)');
  console.log('  --no-register              Install without touching global.json');
  console.log('  --cache-dir <path>         Marketplace cache directory (default ~/.meta-skills/marketplace)');
  console.log('  --port <n>                 Dashboard server port (default 7777; v1.4)');
}

// Î“Ã¶Ã‡Î“Ã¶Ã‡ Main Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡

// Î“Ã¶Ã‡Î“Ã¶Ã‡ Main Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡Î“Ã¶Ã‡

async function main() {
  const args = process.argv.slice(2);

  // Handle --help and --version globally
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(PKG.version);
    return;
  }

  if (args.length === 0) {
    showHelp();
    return;
  }

  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'init':     await cmdInit(rest); break;
      case 'record':   await cmdRecord(rest); break;
      case 'aggregate': await cmdAggregate(rest); break;
      case 'improve':  await cmdImprove(rest); break;
      case 'maintain': await cmdMaintain(rest); break;
      case 'validate': await cmdValidate(rest); break;
      case 'status':   cmdStatus(rest); break;
      case 'sync':     await cmdSync(rest); break;
      case 'search':   await cmdSearch(rest); break;
      case 'install':  await cmdInstall(rest); break;
      case 'propose':   await cmdPropose(rest); break;
      case 'marketplace': await cmdMarketplace(rest); break;
      case 'dashboard':   await cmdDashboard(rest); break;
      case 'agent-config': await cmdAgentConfig(rest); break;
      default:
        console.error(`✗ unknown command: ${command}`);
        console.error('  Run `meta-skills --help` for usage.');
        process.exit(1);
    }
  } catch (e) {
    console.error(`Î“Â£Ã¹ ${e.message}`);
    process.exit(1);
  }
}

main();
