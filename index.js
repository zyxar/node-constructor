#!/usr/bin/env node

/* node-constructor
 * Copyright 2015 Markus Tzoe <chou.marcus@gmail.com>
 */
/* node-builder
 * Copyright 2011 Jaakko-Heikki Heusala <jheusala@iki.fi>
 */

(function() {
  'use strict';
  // Prepare modules
  var child_process = require('child_process');
  var fs = require('fs');
  var path = require('path');

  var optimist = require('optimist');
  var log4js = require('log4js');
  log4js.configure({
    appenders: [{
      type: 'console',
      layout: {
        type: 'pattern',
        pattern: '%d  - %p: %c - %m',
        replaceConsole: true
      }
    }]
  });
  var log = log4js.getLogger();

  // Parse arguments
  var args = optimist.usage('Usage: $0 [-q] [--tmpdir=DIR] -o FILE [file(s)]')
    .default('o', 'a.out')
    .default('tmpdir', './tmp')
    .default('installdir', './tmp')
    .default('prefix', 'install')
    .default('log', 'INFO')
    .default('ver', '0.10.36')
    .demand(['o'])
    .argv;

  var source_files = args._;
  if (source_files.length === 0) return log.error('You need to specify at least one js file.');

  log.setLevel(args.log.toUpperCase());

  /* Async preparation for directory */
  function prep_dir (name, next) {
    log.trace('Preparing directory ' + name);
    fs.exists(name, function (exists) {
      if (exists) return next();
      fs.mkdir(name, '0700', function (err) {
        next(err);
      });
    });
  }

  /* Async preparation for remote files */
  function prep_distfiles (distfile, tofile, next) {
    log.trace('Preparing distfile ' + distfile + ' to ' + tofile);
    fs.exists(tofile, function (exists) {
      if (exists) {
        log.info(tofile, 'exists.');
        // checksum
        return next();
      }
      log.debug('Downloading ' + distfile + ' to ' + tofile);
      doexec('wget', ['-O', tofile, distfile], function (err) {
        next(err);
      });
    });
  }

  /* For make & make install etc */
  function doexec (name, cmdargs, next) {
    var c = child_process.spawn(name, cmdargs);
    var stdout = '';
    var stderr = '';
    c.stdout.on('data', function (data) {
      stdout += data;
    });
    c.stderr.on('data', function (data) {
      stderr += data;
    });
    c.on('exit', function (code) {
      if (stdout) log.debug(stdout);
      if (stderr) log.debug(stderr);
      if (code !== 0) return next(new TypeError(name + ' exited with code ' + code));
      next();
    });
    c.stdin.end();
  }

  /* Async unpack tar.gz */
  function prep_unpack_tgz (name, dir, next) {
    fs.exists(dir + '/configure', function (exists) {
      if (exists) return next();
      log.debug('Unpacking ' + name + ' to ' + dir);
      doexec('tar', ['--strip-components=1', '-C', dir, '-xf', name], function (err) {
        next(err);
      });
    });
  }

  /* Async preparation for source files */
  function prep_source_files (srcdir, files, next) {
    log.trace('Preparing source files into ' + srcdir + '...');
    var file = files[0];
    if (!file) return next('no files!');
    fs.readFile(path.resolve(srcdir, 'node.gyp'), 'utf8', function (err, data) {
      if (err) return log.error('Could not read node.gyp: ' + err);
      data = data.replace(
        /'lib\/zlib\.js'\,\n/,
        '\'lib/zlib.js\', \'lib/_third_party_main.js\',\n'
      );
      fs.writeFile(srcdir + '/node.gyp', data, 'utf8', function (err) {
        if (err) return log.error('Could not write node.gyp: ' + err);
        doexec('cp', ['-f', file, srcdir + '/lib/_third_party_main.js'], function (err) {
          if (err) return log.error('Could not prepare _third_party_main.js: ' + err);
          next();
        });
      });
    });
  }

  /* Change directory */
  function chdir (dir, next) {
    log.debug('Changing to directory: ' + dir);
    try {
      process.chdir(dir);
      next();
    } catch (err) {
      next('chdir: ' + err);
    }
  }

  /* Compile node */
  function compile_node (srcdir, installdir, prefix, next) {
    log.info('Compiling node binary ...');
    var dir = path.resolve(installdir);
    doexec('mkdir', ['-p', path.resolve(installdir, prefix)], function (err) {
      if (err) return log.error('Could prepare destdir: ' + err);
      chdir(srcdir, function (err) {
        if (err) return log.error('Could change directory: ' + err);
        doexec('./configure', ['--prefix=' + prefix], function (err) {
          if (err) return log.error('Could not configure: ' + err);
          doexec('make', [], function (err) {
            if (err) return log.error('Could not make: ' + err);
            doexec('make', ['DESTDIR=' + dir, 'install'], function (err) {
              if (err) return log.error('Could not make install: ' + err);
              next();
            });
          });
        });
      });
    });
  }

  /* Async preparation for output file */
  function prep_output_file (bindir, outfile, next) {
    log.info('Installing to ' + outfile + ' ...');
    doexec('cp', ['-f', bindir + '/node', outfile], function (err) {
      if (err) return next('Could not install ' + outfile + ': ' + err);
      next();
    });
  }

  /* Async builder cycle */
  var outputfile = path.resolve(path.normalize(args.o));
  var tmpdir = path.resolve(path.normalize(args.tmpdir));
  var bindir = path.resolve(args.installdir, args.prefix, 'bin');
  prep_dir(tmpdir, function (err) {
    if (err) return log.error('Could not prepare: ' + tmpdir + ': ' + err);
    var sourcefile = tmpdir + '/node-v'+args.ver+'.tar.gz';
    var distfile = 'http://nodejs.org/dist/v'+args.ver+'/node-v'+args.ver+'.tar.gz';
    prep_distfiles(distfile, sourcefile, function (err) {
      if (err) return log.error('Could not prepare: ' + args.distfile + ' to ' + sourcefile + ': ' + err);
      var distdir = path.resolve(tmpdir, 'node-v'+args.ver);
      prep_dir(distdir, function (err) {
        if (err) return log.error('Could not prepare: ' + distdir + ': ' + err);
        prep_unpack_tgz(sourcefile, distdir, function (err) {
          if (err) return log.error('Unpack failed for ' + sourcefile + ': ' + err);
          prep_source_files(distdir, source_files, function (err) {
            if (err) return log.error('Preparing for source files failed: ' + err);
            compile_node(distdir, args.installdir, args.prefix, function (err) {
              if (err) return log.error('Compiling node failed: ' + err);
              prep_output_file(bindir, outputfile, function (err) {
                if (err) return log.error('Installing binary failed: ' + err);
                log.info('DONE.');
              });
            });
          });
        });
      });
    });
  });
}());

/* EOF */
