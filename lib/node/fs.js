// NOTE: This is largely taken from Atom's `asar` patch here: https://raw.githubusercontent.com/electron/electron/master/lib/common/asar.js

const mkdirp = require('mkdirp')
const path = require('path')
const pkglock = require('../pkglock.js')
const util = require('util')

// Create a ENOENT error.
function notFoundError (filePath, cb) {
  const error = new Error(`ENOENT, ${filePath} not found`)
  error.code = 'ENOENT'
  error.errno = -2
  if (typeof cb !== 'function') {
    throw error
  }
  process.nextTick(() => cb(error))
}

// Create a ENOTDIR error.
function notDirError (cb) {
  const error = new Error('ENOTDIR, not a directory')
  error.code = 'ENOTDIR'
  error.errno = -20
  if (typeof cb !== 'function') {
    throw error
  }
  process.nextTick(() => cb(error))
}

// Create an EISDIR error.
function isDirError (filename, op, cb) {
  const error = new Error(`EISDIR: illegal operation on a directory, ${op}, ${filename}`)
  error.code = 'EISDIR'
  error.errno = -21
  if (typeof cb !== 'function') {
    throw error
  }
  process.nextTick(() => cb(error))
}

// Create an EACCES error.
function accessError (filePath, cb) {
  const error = new Error(`EACCES, permission denies, access '${filePath}'`)
  error.code = 'EACCES'
  error.errno = -13
  if (typeof cb !== 'function') {
    throw error
  }
  process.nextTick(() => cb(error))
}

// Override APIs that rely on passing file path instead of content to C++.
function overrideAPISync (module, name, arg) {
  if (arg == null) {
    arg = 0
  }
  const old = module[name]
  module[name] = function () {
    const p = arguments[arg]
    const resolved = pkglock.resolve(p)
    if (resolved == null) { return old.apply(this, arguments) }
    if (resolved.isDir) {
      isDirError(p, name)
    }
    if (!resolved) {
      notFoundError(p)
    }

    const stat = pkglock.statSync(resolved, true)
    if (!stat) {
      notFoundError(p)
    }

    arguments[arg] = stat.cachePath
    return old.apply(this, arguments)
  }
}

// Override fs APIs.
module.exports.overrideNode = overrideNode
function overrideNode () {
  const fs = require('fs')
  let gfs
  try { gfs = require('graceful-fs') } catch (e) {}

  function patchFn (name, handler, fs$ = fs, gfs$ = gfs) {
    if (fs$[name]) {
      const wrapper = handler(fs$[name])
      wrapper.orig = fs$[name]
      fs$[name] = wrapper
    }
    if (gfs$ && gfs$[name]) {
      const gfsWrapper = handler(gfs$[name])
      gfsWrapper.orig = gfs$[name]
      gfs$[name] = gfsWrapper
    }
  }

  patchFn('lstatSync', lstatSync => p => {
    try {
      return lstatSync(p)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err
      } else {
        const resolved = pkglock.resolve(p)
        if (!resolved) {
          return notFoundError(p)
        } else {
          const stats = pkglock.statSync(resolved)
          if (!stats) {
            notFoundError(p)
          }
          return stats
        }
      }
    }
  })

  patchFn('lstat', lstat => (p, cb) => {
    return lstat(p, (err, stat) => {
      if (!err) { return cb(err, stat) }
      const resolved = pkglock.resolve(p)
      if (!resolved) {
        return notFoundError(p, cb)
      } else {
        pkglock.stat(resolved).then(stat => {
          if (!stat) {
            notFoundError(p, cb)
          }
          cb(null, stat)
        }, cb)
      }
    })
  })

  patchFn('statSync', statSync => p => {
    try {
      return statSync(p)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err
      } else {
        const resolved = pkglock.resolve(p)
        if (!resolved) {
          return notFoundError(p)
        } else {
          const stats = pkglock.statSync(resolved)
          if (!stats) {
            notFoundError(p)
          }
          return stats
        }
      }
    }
  })

  patchFn('stat', stat => (p, cb) => {
    return stat(p, (err, stat) => {
      if (!err) { return cb(err, stat) }
      const resolved = pkglock.resolve(p)
      if (!resolved) {
        return notFoundError(p, cb)
      } else {
        pkglock.stat(resolved).then(stat => {
          if (!stat) {
            notFoundError(p, cb)
          }
          cb(null, stat)
        }, cb)
      }
    })
  })

  patchFn('statSyncNoException', statSyncNoException => p => {
    const ret = statSyncNoException(p)
    if (ret) {
      return ret
    } else {
      const resolved = pkglock.resolve(p)
      if (!resolved) {
        return false
      } else {
        const stats = pkglock.statSync(resolved)
        if (!stats) {
          return false
        }
        return stats
      }
    }
  })

  patchFn('realpathSync', realpathSync => (p, ...args) => {
    try {
      return realpathSync(p, ...args)
    } catch (err) {
      if (err.code !== 'ENOENT') { throw err }
      const resolved = pkglock.resolve(p)
      if (!resolved) {
        return notFoundError(p)
      } else {
        return resolved.resolvedPath
      }
    }
  })

  patchFn('realpath', realpath => function (p, cache, cb) {
    realpath(p, cache, (err, rp) => {
      if (err && err.code !== 'ENOENT') { return cb(err) }
      if (!err) { return cb(null, rp) }
      const resolved = pkglock.resolve(p)
      if (typeof cache === 'function') {
        cb = cache
        cache = void 0
      }

      process.nextTick(() => {
        if (resolved) {
          cb(null, resolved.resolvedPath)
        } else {
          notFoundError(p, cb)
        }
      })
    })
  })

  patchFn('exists', exists => (p, cb) => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) {
      exists(p, cb)
    } else {
      process.nextTick(() => cb(null, !!resolved))
    }
  })

  patchFn(util.promisify.custom, custom => async p => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) { return custom(p) }
    return !!resolved
  }, fs.exists, gfs.exists) // eslint-disable-line

  patchFn('existsSync', existsSync => p => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) { return existsSync(p) }
    return !!resolved
  })

  patchFn('access', access => (p, mode, cb) => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) {
      return access(p, mode, cb)
    }
    if (typeof mode === 'function') {
      cb = mode
      mode = fs.constants.F_OK
    }
    if (!resolved) {
      return notFoundError(p, cb)
    } else if (resolved.isDir) {
      process.nextTick(() => {
        if (mode === fs.constants.F_OK || fs.constants.R_OK & mode) {
          cb(null)
        } else {
          accessError(p, cb)
        }
      })
    } else {
      pkglock.stat(resolved).then(stat => {
        if (!stat) {
          return notFoundError(p, cb)
        }
        access(stat.cachePath, mode, cb)
      }, cb)
    }
  })

  patchFn('accessSync', accessSync => (p, mode) => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) {
      return accessSync(p, mode)
    }
    if (mode == null) {
      mode = fs.constants.F_OK
    }
    if (!resolved) {
      return notFoundError(p)
    } else if (resolved.isDir) {
      if (mode === fs.constants.F_OK || fs.constants.R_OK & mode) {
        // undefined
      } else {
        return accessError(p)
      }
    } else {
      const stat = pkglock.statSync(resolved)
      if (!stat) {
        notFoundError(p)
      }
      return fs.accessSync(stat.cachePath, mode)
    }
  })

  patchFn('readFile', readFile => (p, options, cb) => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) {
      return readFile(p, options, cb)
    }
    if (typeof options === 'function') {
      cb = options
      options = {
        encoding: null
      }
    } else if (typeof options === 'string') {
      options = {
        encoding: options
      }
    } else if (options === null || options === undefined) {
      options = {
        encoding: null
      }
    } else if (typeof options !== 'object') {
      throw new TypeError('badarg')
    }
    if (resolved.isDir) {
      return isDirError(p, 'read', cb)
    } else if (!resolved) {
      return notFoundError(p, cb)
    }
    const { encoding } = options
    pkglock.read(resolved).then(data => {
      if (encoding) {
        data = data.toString(encoding)
      }
      cb(null, data)
    }, cb)
  })

  patchFn('readFileSync', readFileSync => (p, options) => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) { return readFileSync(p, options) }
    if (resolved.isDir) {
      isDirError(p, 'read')
    } else if (!resolved) {
      notFoundError(p)
    }
    if (!options) {
      options = {
        encoding: null
      }
    } else if (typeof options === 'string') {
      options = {
        encoding: options
      }
    } else if (typeof options !== 'object') {
      throw new TypeError('Bad arguments')
    }
    const { encoding } = options
    const data = pkglock.readSync(resolved)
    if (encoding) {
      return data.toString(encoding)
    } else {
      return data
    }
  })

  patchFn('readdir', readdir => (p, cb) => {
    let found = false
    readdir(p, (err, files) => {
      if (err && err.code !== 'ENOENT') { return cb(err) }
      if (!err) { found = true }
      files = files || []
      const resolved = pkglock.resolve(p)
      if (resolved && resolved.isDir) {
        files.push(...Object.keys(resolved.dir))
        found = true
      } else {
        if (!found) {
          return notFoundError(p, cb)
        } else if (resolved && !resolved.isDir) {
          return notDirError(cb)
        }
      }
      process.nextTick(() => cb(null, [...new Set(files)]))
    })
  })

  patchFn('readdirSync', readdirSync => p => {
    let found = false
    let files = []
    try {
      files = readdirSync(p)
      found = true
    } catch (err) {
      if (err.code !== 'ENOENT') { throw err }
    }
    const resolved = pkglock.resolve(p)
    if (resolved && resolved.isDir) {
      files.push(...Object.keys(resolved.dir))
      found = true
    } else {
      if (!found) {
        notFoundError(p)
      } else if (resolved && !resolved.isDir) {
        notDirError()
      }
    }
    return [...new Set(files)]
  })

  patchFn('chmod', chmod => (p, mode, cb) => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) {
      return chmod(p, mode, cb)
    } else if (!resolved) {
      notFoundError(p)
    } else if (resolved.isDir) {
      mkdirp(p, { mode }, cb)
    } else {
      return mkdirp(path.dirname(p), err => {
        if (err) { cb(err) }
        fs.readFile(p, (err, data) => {
          if (err) { cb(err) }
          fs.writeFile(p, data, { mode }, cb)
        })
      })
    }
  })

  patchFn('open', open => (p, flags, mode, cb) => {
    if (!cb) { cb = mode; mode = undefined }
    open(p, flags, mode, (err, fd) => {
      if (!err || err.code !== 'ENOENT') { return cb(err, fd) }
      const resolved = pkglock.resolve(p)
      if (!resolved) {
        notFoundError(p, cb)
      } else if (resolved.isDir) {
        isDirError(p, 'read', cb)
      } else {
        pkglock.stat(resolved, true).then(stat => {
          if (!stat) {
            notFoundError(p)
          } else if (flags === 'r') {
            // If we're only reading, we can read straight off cacache
            return open(stat.cachePath, flags, mode, cb)
          } else {
            fs.copyFile(stat.cachePath, p, err => {
              if (err) { return cb(err) }
              fs.chmod(p, 0o755, err => {
                if (err) { return cb(err) }
                open(p, flags, mode, cb)
              })
            })
          }
        }).catch(cb)
      }
    })
  })

  patchFn('openSync', openSync => (p, flags, mode) => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) {
      return openSync(p, flags, mode)
    } else if (!resolved) {
      notFoundError(p)
    } else if (resolved.isDir) {
      isDirError(p, 'read')
    } else {
      const stat = pkglock.statSync(resolved, true)
      if (!stat) {
        notFoundError(p)
      } else if (flags === 'r') {
        // If we're only reading, we can read straight off cacache
        return openSync(stat.cachePath, flags, mode)
      } else {
        fs.copyFileSync(stat.cachePath, p)
        fs.chmodSync(p, 0o755)
        return openSync(p, flags, mode)
      }
    }
  })

  patchFn('createReadStream', createReadStream => (p, opts) => {
    const resolved = pkglock.resolve(p)
    if (!resolved || resolved.isDir) {
      return createReadStream(p, opts)
    } else {
      const stat = pkglock.statSync(resolved, true)
      if (!stat) {
        // Should emit ENOENT
        return createReadStream(p, opts)
      } else if (opts && opts.flags === 'r') {
        // If we're only reading, we can read straight off cacache
        return createReadStream(stat.cachePath, opts)
      } else {
        fs.copyFileSync(stat.cachePath, p)
        fs.chmodSync(p, 0o755)
        return createReadStream(p, opts)
      }
    }
  })

  patchFn('createWriteStream', createWriteStream => (p, opts) => {
    const resolved = pkglock.resolve(p)
    if (!resolved || resolved.isDir) {
      return createWriteStream(p, opts)
    } else {
      const stat = pkglock.statSync(resolved, true)
      if (!stat) {
        // Should emit ENOENT
        return createWriteStream(p, opts)
      } else {
        fs.copyFileSync(stat.cachePath, p)
        fs.chmodSync(p, 0o755)
        return createWriteStream(p, opts)
      }
    }
  })

  patchFn('internalModuleReadJSON', internalModuleReadJSON => p => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) { return internalModuleReadJSON(p) }
    if (!resolved || resolved.isDir) { return }
    try {
      return pkglock.readSync(resolved).toString('utf8')
    } catch (err) {
    }
  }, process.binding('fs'), {})

  patchFn('internalModuleStat', internalModuleStat => p => {
    const resolved = pkglock.resolve(p)
    if (resolved == null) { return internalModuleStat(p) }
    if (resolved && resolved.isFile) { return 0 }
    if (resolved && resolved.isDir) { return 1 }
    if (!resolved && path.basename(p) === 'node_modules') { return 1 }
    return -34
  }, process.binding('fs'), {})

  overrideAPISync(process, 'dlopen', 1)
  overrideAPISync(require('module')._extensions, '.node', 1)
}
