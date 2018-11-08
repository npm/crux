'use strict'

const figgyPudding = require('figgy-pudding')
const fs = require('graceful-fs')
const log = require('npmlog')
const path = require('path')

const installer = require('../installer.js')

const Prepare = module.exports = {
  command: 'prepare',
  aliases: ['prep'],
  describe: 'pre-fetch all dependencies',
  builder (y) {
    return y.help().alias('help', 'h').options(Prepare.options)
  },
  options: Object.assign(require('../common-opts.js'), {
    force: {
      alias: 'f',
      describe: 'Unconditionally prepare dependencies.',
      type: 'boolean'
    }
  }),
  handler: async argv => prepare(argv)
}

async function prepare (argv) {
  const opts = figgyPudding(Prepare.options)(argv)

  log.level = opts.loglevel
  if (argv.force || !await checkPkgLock()) {
    try {
      await installer({
        log (level, ...args) {
          return log[level](...args)
        }
      })
    } catch (e) {
      log.error('installer', e)
    }
  }
  process.tink = {
    cache: argv.cache
  }

  function checkPkgLock () {
    try {
      const base = process.cwd()
      const lock = JSON.parse(stripBOM(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8')))
      const map = JSON.parse(stripBOM(fs.readFileSync(path.join(base, 'node_modules', '.pkglock-hash'), 'utf8')))
      require('ssri').checkData(
        JSON.stringify(lock), map.lockfile_integrity, { error: true }
      )
      return map
    } catch (err) {
      return false
    }
  }

  function stripBOM (str) {
    return str.replace(/^\uFEFF/, '')
  }
}
