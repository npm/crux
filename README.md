[![npm](https://img.shields.io/npm/v/crux.svg)](https://npm.im/crux) [![license](https://img.shields.io/npm/l/crux.svg)](https://npm.im/crux) [![Travis](https://img.shields.io/travis/npm/crux.svg)](https://travis-ci.org/npm/crux) [![AppVeyor](https://ci.appveyor.com/api/projects/status/github/npm/crux?svg=true)](https://ci.appveyor.com/project/npm/crux) [![Coverage Status](https://coveralls.io/repos/github/npm/crux/badge.svg?branch=latest)](https://coveralls.io/github/npm/crux?branch=latest)

[`crux`](https://github.com/npm/crux)? is an experimental package manager for
JavaScript. Don't expect to be able to use this with any of your existing
projects.

## Usage

`$ npx npm/crux`

## Table of Contents

* [Features](#features)
* [Contributing](#contributing)
* [API](#api)

### Features

* (mostly) npm-compatible project installation

### Contributing

The crux team enthusiastically welcomes contributions and project
participation! There's a bunch of things you can do if you want to contribute!
The [Contributor Guide](CONTRIBUTING.md) has all the information you need for
everything from reporting bugs to contributing entire new features. Please don't
hesitate to jump in if you'd like to, or even ask us questions if something
isn't clear.

### TODO

* [x] lay out project
* [x] extract exploded pacote tarballs into cacache + build per-project index
* [x] do some basic benchmarks
* [x] write a node loader that can load a package through the file index
* [x] do some load time benchmarks
* [ ] write tests for fs overrides
* [ ] use spawn-wrap to support child_process calls
* [ ] use `cache` from config, not from pkgmap (stop writing it there)
* [ ] make pkgmap auto-fetch packages for missing hashes on the fly
* [ ] warn if installing a package that requires run-scripts
* [ ] warn if installing something that requires bin/man linking
* [ ] add support for removing package tarballs from cache
* [ ] add fallback where "incompatible" packages get dumped into node_modules (and tagged a such in `package-map.json`)
* [ ] add support for node-gyp build caching to make native packages compatible
* [ ] add support for bin/man linking
* [ ] benchmark wubwub?
* [ ] optimize fs and module load operations (need to analyze)
