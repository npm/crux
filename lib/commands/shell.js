'use strict'

const cp = require('child_process')
const figgyPudding = require('figgy-pudding')
const path = require('path')
const Module = require('module')

const prepare = require('./prepare.js')
const { createRepl } = require('../node/repl.js')

const Shell = module.exports = {
  command: 'shell',
  aliases: ['sh'],
  describe: 'Launch a tink shell or execute a script',
  builder (yargs) {
    return yargs.help().alias('help', 'h').options(Shell.options)
  },
  options: Object.assign(require('../common-opts'), {
    _: { default: [] },
    'ignore-scripts': {},
    nodeArg: {
      alias: ['n', 'node-arg'],
      describe: 'Arguments to pass down directly to node',
      type: 'array'
    },
    prefix: {
      alias: 'C',
      describe: 'Directory to execute package management operations in.',
      type: 'string'
    },
    restore: {
      alias: 'restore-missing',
      default: true,
      type: 'boolean'
    },
    also: {
      hidden: true
    },
    dev: {
      hidden: true
    },
    development: {
      hidden: true
    },
    only: {
      hidden: true
    },
    production: {
      type: 'boolean',
      describe: 'Limit downloads to production dependencies, skipping devDependencies.'
    }
  }),
  // lazy-load subcommands
  handler: async argv => shell(argv)
}

async function shell (argv) {
  const opts = figgyPudding(Shell.options)(argv)

  await prepare.handler(argv)
  if (opts.nodeArg && opts.nodeArg.length) {
    cp.spawnSync(
      process.argv[0],
      ['-r', require.resolve('../node/index.js'), ...(opts.nodeArg || []), ...(argv.script ? [argv.script, ...(argv.arguments || [])] : [])],
      { stdio: 'inherit' }
    )
  } else if (argv._.length > 1) {
    require('clear-module').match(/yargs/)
    process.argv = [
      process.argv[0],
      path.resolve(argv._[1]),
      ...argv._.slice(2)
    ]
    Module.runMain()
  } else {
    createRepl(process.env, {}, (err, repl) => {
      if (err) {
        throw err
      }
      repl.on('exit', function () {
        if (repl._flushing) {
          repl.pause()
          return repl.once('flushHistory', function () {
            process.exit()
          })
        }
        process.exit()
      })
    })
  }
}
