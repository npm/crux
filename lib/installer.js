'use strict'

const BB = require('bluebird')

const {
  linkBin: binLink,
  extract,
  getPrefix,
  log: npmlog,
  logicalTree: buildLogicalTree,
  parseArg: npa,
  readJSON: readPkgJson,
  runScript,
  verifyLock: lockVerify
} = require('libnpm')

const config = require('./config.js')
const ensurePackage = require('./ensure-package.js')
const path = require('path')
const ssri = require('ssri')

const fs = require('graceful-fs')
const glob = BB.promisify(require('glob'))
const mkdirp = BB.promisify(require('mkdirp'))
const rimraf = BB.promisify(require('rimraf'))
const { spawn } = require('child_process')

const readFileAsync = BB.promisify(fs.readFile)
const readdirAsync = BB.promisify(fs.readdir)
const realpathAsync = BB.promisify(fs.realpath)
const symlinkAsync = BB.promisify(fs.symlink)
const writeFileAsync = BB.promisify(fs.writeFile)

class Installer {
  constructor (opts) {
    this.opts = config(opts)

    // Stats
    this.startTime = Date.now()
    this.runTime = 0
    this.timings = { scripts: 0 }
    this.pkgCount = 0

    // Misc
    this.log = (level, ...msgs) => {
      this.opts.log[level](...msgs)
    }
    this.onlyDeps = opts.only && new Set(opts.only)
    this.pkg = null
    this.tree = null
    this.validLockHash = false
    this.force = this.opts.force
    this.failedDeps = new Set()
  }

  async timedStage (name) {
    const start = Date.now()
    const ret = await this[name].apply(this, [].slice.call(arguments, 1))
    this.timings[name] = Date.now() - start
    this.log('info', name, `Done in ${this.timings[name] / 1000}s`)
    return ret
  }

  async run () {
    try {
      await this.timedStage('prepare')
      if (!this.validLockHash || this.force) {
        this.log('info', 'Generating new package map')
        await this.timedStage('fetchTree', this.tree)
        await this.timedStage('updateJson', this.tree)
        await this.timedStage('buildTree', this.tree)
        await this.tinkifyBins()
        await this.timedStage('runScript', 'prepublish', this.pkg, this.prefix)
        await this.timedStage('runScript', 'prepare', this.pkg, this.prefix)
        await this.timedStage('writeLockHash')
      } else {
        this.log('info', 'Found valid existing package map. Skipping fetch.')
      }
      await this.timedStage('teardown')
      this.runTime = Date.now() - this.startTime
      this.log(
        'info',
        'run-scripts',
        `total script time: ${this.timings.scripts / 1000}s`
      )
      this.log(
        'info',
        'run-time',
        `total run time: ${this.runTime / 1000}s`
      )
      if (this.pkgCount) {
        this.log(
          'info',
          'package-count',
          `total packages: ${this.pkgCount}`
        )
      }
    } catch (err) {
      if (err.message.match(/aggregate error/)) {
        throw err[0]
      } else {
        throw err
      }
    } finally {
      await this.timedStage('teardown')
    }
    this.opts = null
    return this
  }

  async prepare () {
    this.log('info', 'prepare', 'initializing installer')

    const prefix = (
      this.opts.prefix && this.opts.global
        ? this.opts.prefix
        // There's some Special™ logic around the `--prefix` config when it
        // comes from a config file or env vs when it comes from the CLI
        : process.argv.some(arg => arg.match(/^\s*--prefix\s*/i))
          ? this.opts.prefix
          : await getPrefix(process.cwd())
    )
    this.prefix = prefix
    this.log('verbose', 'prepare', 'installation prefix: ' + prefix)
    await BB.join(
      readJson(prefix, 'package.json'),
      readJson(prefix, 'package-lock.json', true),
      readJson(prefix, 'npm-shrinkwrap.json', true),
      readJson(prefix, 'node_modules/.pkglock-hash', true),
      (pkg, lock, shrink, lockHash) => {
        if (shrink) {
          this.log('verbose', 'prepare', 'using npm-shrinkwrap.json')
        } else if (lock) {
          this.log('verbose', 'prepare', 'using package-lock.json')
        }
        pkg._shrinkwrap = shrink || lock
        this.pkg = pkg
        this.pkglockHash = lockHash
      }
    )
    await this.checkLock()
    this.tree = buildLogicalTree(this.pkg, this.pkg._shrinkwrap)
    if (this.onlyDeps && this.onlyDeps.size) {
      for (const [key, dep] of this.tree.dependencies.entries()) {
        if (!this.onlyDeps.has(key)) {
          this.tree.delDep(dep)
        }
      }
      if (!this.tree.dependencies.size) {
        throw new Error('No dependencies found matching filter')
      }
    }
    this.log('silly', 'tree', this.tree)
    this.expectedTotal = 0
    this.tree.forEach((dep, next) => {
      this.expectedTotal++
      next()
    })
  }

  async teardown () {
    this.log('verbose', 'teardown', 'shutting down')
  }

  async checkLock () {
    this.log('verbose', 'checkLock', 'verifying package-lock data')
    const pkg = this.pkg
    const prefix = this.prefix
    if (
      this.pkglockHash &&
      !ssri.checkData(
        JSON.stringify(pkg._shrinkwrap),
        this.pkglockHash.lockfile_integrity
      )
    ) {
      this.validLockHash = false
    }
    if (!pkg._shrinkwrap || !pkg._shrinkwrap.lockfileVersion) {
      this.log('warn', 'No lockfile detected. Regenerating.')
      await this.npmInstall()
    }
    if (!pkg._shrinkwrap || !pkg._shrinkwrap.lockfileVersion) {
      throw new Error(`npm install to generate package-lock.json failed. This is a bug.`)
    }
    const result = await lockVerify(prefix)
    if (result.status) {
      result.warnings.forEach(w => this.log('warn', 'lockfile', w))
    } else {
      this.log('warn', 'lockfile', 'some package-lock dependencies are not in sync with package.json.\n' + result.errors.join('\n'))
      if (result.warnings.length) {
        this.log('warn', 'lockfile', result.warnings.map(w => 'Warning: ' + w).join('\n'))
      }
      this.log('warn', 'lockfile', 'Updating package-lock.')
      await this.npmInstall()
    }
  }

  async npmInstall () {
    await BB.fromNode(cb => {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      spawn(npmBin, [
        'install',
        '--package-lock',
        '--package-lock-only'
      ], {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit'
      }).on('error', cb).on('close', code => cb(null, code))
    })
    this.pkg._shrinkwrap = await readJson(this.prefix, 'package-lock.json')
  }

  async fetchTree (tree) {
    this.log('verbose', 'fetchTree', 'making sure all required deps are in the cache')
    // const cg = this.log('newItem', 'fetchTree', this.expectedTotal)
    await tree.forEachAsync(async (dep, next) => {
      if (!this.checkDepEnv(dep)) { return }
      const depPath = dep.path(this.prefix)
      const spec = npa.resolve(dep.name, dep.version, this.prefix)
      if (dep.isRoot) {
        return next()
      } else if (spec.type === 'directory') {
        const relative = path.relative(path.dirname(depPath), spec.fetchSpec)
        this.log('silly', 'fetchTree', `${dep.name}@${spec.fetchSpec} -> ${depPath} (symlink)`)
        await mkdirp(path.dirname(depPath))
        try {
          await symlinkAsync(relative, depPath, 'junction')
        } catch (e) {
          await rimraf(depPath)
          await symlinkAsync(relative, depPath, 'junction')
        }
        await next()
        this.pkgCount++
        // cg.completeWork(1)
      } else {
        this.log('silly', 'fetchTree', `${dep.name}@${dep.version} -> ${depPath}`)
        if (dep.bundled) {
          // cg.completeWork(1)
          this.pkgCount++
          await next()
        } else {
          dep.metadata = await ensurePackage(
            this.opts.cache, dep.name, dep, this.opts.concat({
              warn: msg => this.opts.log('warn', msg)
            })
          )
          const pkg = await readJson(dep.path(this.prefix), 'package.json')
          if (
            (
              pkg.scripts && (
                pkg.scripts.preinstall ||
                pkg.scripts.install ||
                pkg.scripts.postinstall
              )
            ) || (
              pkg.bundleDependencies ||
              pkg.bundledDependencies
            )
          ) {
            await extract(
              npa.resolve(dep.name, dep.version),
              dep.path(this.prefix),
              this.opts.concat({
                integrity: dep.integrity,
                resolved: dep.resolved
              })
            )
          }
          // cg.completeWork(1)
          this.pkgCount++
          await next()
        }
      }
    }, { concurrency: 50, Promise: BB })
    // cg.finish()
  }

  checkDepEnv (dep) {
    const includeDev = (
      this.opts.dev ||
      this.opts.development ||
      (
        !/^prod(uction)?$/.test(this.opts.only) &&
        !this.opts.production
      ) ||
      /^dev(elopment)?$/.test(this.opts.only) ||
      /^dev(elopment)?$/.test(this.opts.also)
    )
    const includeProd = !/^dev(elopment)?$/.test(this.opts.only)
    return (dep.dev && includeDev) || (!dep.dev && includeProd)
  }

  async updateJson (tree) {
    this.log('verbose', 'updateJson', 'checking for native builds')
    const pkgJsons = new Map()
    await tree.forEachAsync(async (dep, next) => {
      if (!this.checkDepEnv(dep)) { return }
      const depPath = dep.path(this.prefix)
      await next()
      const pkg = await readJson(depPath, 'package.json')
      await this.updateInstallScript(dep, pkg)
      pkgJsons.set(dep, pkg)
    }, { concurrency: 100, Promise: BB })
    this.pkgJsons = pkgJsons
    return pkgJsons
  }

  async updateInstallScript (dep, pkg) {
    const depPath = dep.path(this.prefix)
    if (!pkg.scripts || !pkg.scripts.install) {
      const files = await readdirAsync(depPath)
      if (files.find(f => /\.gyp$/i.test(f))) {
        if (!pkg.scripts) {
          pkg.scripts = {}
        }
        pkg.scripts.install = 'node-gyp rebuild'
      }
    }
    let modified
    if (pkg.scripts) {
      if (pkg.scripts.preinstall) {
        const old = pkg.scripts.preinstall
        pkg.scripts.preinstall = pkg.scripts.preinstall.replace(/\bnode([^-\w]|$)/, 'tish$1')
        modified = pkg.scripts.preinstall === old
      }
      if (pkg.scripts.install) {
        const old = pkg.scripts.install
        pkg.scripts.install = pkg.scripts.install.replace(/\bnode([^-\w]|$)/, 'tish$1')
        modified = pkg.scripts.install === old
      }
      if (pkg.scripts.postinstall) {
        const old = pkg.scripts.postinstall
        pkg.scripts.postinstall = pkg.scripts.postinstall.replace(/\bnode([^-\w]|$)/, 'tish$1')
        modified = pkg.scripts.postinstall === old
      }
      if (modified) {
        await writeFileAsync(path.join(depPath, 'package.json'), JSON.stringify(pkg, null, 2))
      }
    }
    return pkg
  }

  async buildTree (tree) {
    this.log('verbose', 'buildTree', 'finalizing tree and running scripts')
    await tree.forEachAsync(async (dep, next) => {
      if (!this.checkDepEnv(dep)) { return }
      try {
        const spec = npa.resolve(dep.name, dep.version)
        const depPath = dep.path(this.prefix)
        this.log('silly', 'buildTree', `linking ${spec}`)
        const pkg = this.pkgJsons.get(dep)
        await this.runScript('preinstall', pkg, depPath)
        await next() // build children between preinstall and binLink
        // Don't link root bins
        if (
          dep.isRoot ||
          !(pkg.bin || pkg.man || (pkg.directories && pkg.directories.bin) || (pkg.scripts && (pkg.scripts.install || pkg.scripts.postinstall)))
        ) {
          // We skip the relatively expensive readPkgJson if there's no way
          // we'll actually be linking any bins or mans
          return
        }
        const pkgJson = await readPkgJson(path.join(depPath, 'package.json'))
        await binLink(pkgJson, depPath, false, {
          force: this.opts.force,
          ignoreScripts: this.opts['ignore-scripts'],
          log: npmlog,
          name: pkg.name,
          pkgId: pkg.name + '@' + pkg.version,
          prefix: this.prefix,
          prefixes: [this.prefix]
        })
        await this.runScript('install', pkg, depPath)
        await this.runScript('postinstall', pkg, depPath)
      } catch (e) {
        if (dep.optional) {
          this.failedDeps.add(dep)
        } else {
          throw e
        }
      }
    }, { concurrency: 50, Promise: BB })
  }

  async tinkifyBins () {
    const old = process.tink
    process.tink = null
    const bins = await glob(path.join(this.prefix, 'node_modules/**/.bin/*'))
    process.tink = old
    this.log('verbose', 'tinkifyBins', 'convering installed bins to use tink:', bins)
    return BB.map(bins, async bin => {
      const real = await realpathAsync(bin)
      const data = (await readFileAsync(real, 'utf8')).replace(/^(#!.*\b)node([^-\w]|$)/g, '$1tish$2')
      await writeFileAsync(real, data, 'utf8')
    }, { concurrency: 50, Promise: BB })
  }

  // A cute little mark-and-sweep collector!
  async garbageCollect (tree) {
    if (!this.failedDeps.size) { return }
    const purged = await sweep(
      tree,
      this.prefix,
      mark(tree, this.failedDeps)
    )
    this.purgedDeps = purged
    this.pkgCount -= purged.size
  }

  async runScript (stage, pkg, pkgPath) {
    const start = Date.now()
    if (!this.opts['ignore-scripts']) {
      // TODO(mikesherov): remove pkg._id when npm-lifecycle no longer relies on it
      pkg._id = pkg.name + '@' + pkg.version
      const ret = await runScript(pkg, stage, pkgPath, {
        dir: this.prefix,
        log: npmlog,
        config: this.opts
      })
      this.timings.scripts += Date.now() - start
      return ret
    }
  }

  async writeLockHash (map) {
    const nm = path.join(this.prefix, 'node_modules')
    try {
      await mkdirp(nm)
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err
      }
    }
    return writeFileAsync(path.join(nm, '.pkglock-hash'), JSON.stringify({
      lockfile_integrity: ssri.fromData(
        JSON.stringify(this.pkg._shrinkwrap)
      ).toString()
    }))
  }
}

module.exports = treeFrog
async function treeFrog (opts) {
  return new Installer(opts).run()
}
module.exports.Installer = Installer

function mark (tree, failed) {
  const liveDeps = new Set()
  tree.forEach((dep, next) => {
    if (!failed.has(dep)) {
      liveDeps.add(dep)
      next()
    }
  })
  return liveDeps
}

async function sweep (tree, prefix, liveDeps) {
  const purged = new Set()
  await tree.forEachAsync(async (dep, next) => {
    await next()
    if (
      !dep.isRoot && // never purge root! 🙈
      !liveDeps.has(dep) &&
      !purged.has(dep)
    ) {
      purged.add(dep)
      await rimraf(dep.path(prefix))
    }
  }, { concurrency: 50, Promise: BB })
  return purged
}

function stripBOM (str) {
  return str.replace(/^\uFEFF/, '')
}

module.exports._readJson = readJson
async function readJson (jsonPath, name, ignoreMissing) {
  try {
    const str = await readFileAsync(path.join(jsonPath, name), 'utf8')
    return JSON.parse(stripBOM(str))
  } catch (err) {
    if (err.code !== 'ENOENT' || !ignoreMissing) {
      throw err
    }
  }
}
