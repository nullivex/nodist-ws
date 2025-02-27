'use strict';
var P = require('bluebird');
var fs = require('fs');
var mkdirp = require('mkdirp');
var ncp = require('ncp');
var path = require('path');
var rimraf = require('rimraf');
var semver = require('semver');
var tar = require('tar')
var zlib = require('zlib')

var buildHelper = require('./build');

var octokit = require('./octokit');
var vermanager = require('./versions')

//make some promising APIs
P.promisifyAll(fs);
ncp = P.promisify(ncp);
rimraf = P.promisify(rimraf);

var debug = require('debug')('nodist:npm')

/**
 * npmist /nopmist/
 * This poorly named module manages npm versions
 */
function npmist(nodist, envVersion) {
  this.nodist = nodist
  this.envVersion = envVersion
  //define where we store our npms
  this.repoPath = path.resolve(path.join(this.nodist.nodistDir,'npmv'));
}

module.exports = npmist

var NPMIST = npmist.prototype

/**
 * Npm version >= 18 using symlinks that do not work in windows and have to be fixed
 * this function replace the broken symlinks with NTFS junction or move the directory if junctions are not supported
 *
 * @param {string} dirPath
 * @returns {Promise<number>} number of changed links
 */
async function resolveLinkedWorkspaces(dirPath) {
  let fixedLinks = 0;
  const files = await fs.readdirAsync(dirPath, { withFileTypes: true });
  const dirPromises = [];
  for (const file of files) {
    const filePath = path.join(dirPath, file.name);
    if (file.isSymbolicLink()) {
      const linkTarget = await fs.readlinkAsync(filePath);
      debug('Fix symlink for ', filePath, 'with target', linkTarget);
      await fs.unlinkAsync(filePath);
      try {
        await fs.symlinkAsync(linkTarget, filePath, 'junction');
      } catch (e) {
        await fs.renameAsync(path.join(dirPath, linkTarget), filePath);
      }
      fixedLinks++;
    } else if (file.isDirectory()) {
      dirPromises.push(resolveLinkedWorkspaces(filePath));
    }
  }
  return (await Promise.all(dirPromises)).reduce((sum, num) => sum + num, fixedLinks);
}

/**
 * List available NPM versions
 * @return {string}
 */
NPMIST.listAvailable = function(){
  return Promise.all([
    octokit.paginate(octokit.rest.repos.listReleases, {
      owner: 'npm',
      repo: 'npm',
      per_page: 100
    }, function(response) {
      return response.data.map(function(release) { return release.tag_name; });
    }),
    octokit.paginate(octokit.rest.repos.listReleases, {
      owner: 'npm',
      repo: 'cli',
      per_page: 100
    }, function(response) {
      return response.data.map(function(release) { return release.tag_name; });
    })
  ])
  .then(([npm, cli]) => {
    // The npm project has two kinds of releases: releases of npm,
    // and releases of other utility libraries.
    // Ignore the releases of libraries. They are named "package: version",
    // while core npm releases are named just "version".
    cli = cli.filter( release => release.name.indexOf(':') < 0 );

    return npm.concat(cli);
  });
};

/**
 * List all npm versions installed in this.repoPath
 * @param {function} cb A callback with (error, arrayOfVersions)
 * @return {*} nothing
 */
NPMIST.listInstalled = function listInstalled(cb) {
  //return from cache if we can
  if(this.installedCache){
    return process.nextTick(() => {
      cb(null, this.installedCache);
    });
  }

  fs.readdir(this.repoPath, (err, ls) => {
    if(err){
      return cb({
        message: 'Reading the version directory ' +
        this.repoPath + ' failed: ' + err.message
      });
    }

    ls = ls.filter(semver.valid)
    ls.sort(function(v1, v2){
      if(vermanager.compareable(v1) > vermanager.compareable(v2)){
        return 1;
      }
      else{
        return -1;
      }
    });
    //set cache for later
    this.installedCache = ls;
    return cb(null, ls);
  });
};

function getNpmReleases(page) {
  return octokit.rest.repos.listReleases({
    owner: 'npm',
    repo: 'cli',
    per_page: 50,
    page,
  }).then((response) => response.data.map(release => release.tag_name)
    .filter((version) => /^v\d+\.\d+\.\d+$/.test(version))
    .sort(semver.compare)
  );
}

/**
 * Get latest NPM version
 * @return {string}
 */
NPMIST.latestVersion = async function(){
  // use list instead of getLatestRelease because there are non npm releases in the cli repo
  let releases = [];
  let page = 1;
  while (releases.length === 0) {
    releases = await getNpmReleases(page);
    page += 1;
  }

  return releases.pop();
};

/**
 * Get latest NPM version
 * @return {string}
 */
NPMIST.matchingVersion = function(){
  return new Promise((done, reject) => {
    this.nodist.getCurrentVersion((er, nodeVersion) => {
      if (er) return reject(er)
      this.nodist.getMatchingNpmVersion(nodeVersion, (er, npmVersion) => {
        if (er) return reject(er)
	      done(npmVersion)
      })
    })
  })
};

/**
 * Get a download URL for the version
 * @param {string} version
 * @return {string}
 */
NPMIST.downloadUrl = function(version){
  return 'https://codeload.github.com/npm/cli/tar.gz/vVERSION'
    .replace('VERSION',version.replace('v',''));
};

NPMIST.resolveVersionLocally = function(spec, done) {
  if (!spec) return done()
  this.listInstalled((er, installed) => {
    if (spec === 'latest') return done(null, installed[installed.length - 1])

    if (spec === 'match') {
      this.nodist.getCurrentVersion((er, nodeVersion) => {
        if (er) return done(er)
        this.nodist.getMatchingNpmVersion(nodeVersion, (er, npmVersion) => {
          if (er) return done(er)
          resolveVersion(npmVersion, installed)
        })
      })
      return
    }

    resolveVersion(spec, installed)
  })
  function resolveVersion(spec, installed) {
    //try to get a version if its explicit
    var version = semver.clean(spec);
    //support version ranges
    if(semver.validRange(spec)){
      version = semver.maxSatisfying(installed,spec);
    }
    done(null,version);
  }
}

/**
 * Resolve a version from a string
 * @param {string} v
 * @param {function} done
 */
NPMIST.resolveVersion = function(v,done){
  if ('latest' === v || !v) {
    this.latestVersion()
    .then((latest) => {
      done(null, latest)
    })
    return
  }

  if ('match' === v) {
    this.matchingVersion()
    .then((version) => {
      done(null, version)
    })
    return
  }

  this.listAvailable()
  .then(function(available){
    //try to get a version if its explicit
    var version = semver.clean(v);
    //support version ranges
    if(semver.validRange(v)){
      version = semver.maxSatisfying(available,v);
    }
    if (!version) {
      done(new Error('Version spec, "' + v + '", didn\'t match any version'));
      return;
    }
    done(null,version);
  })
  .catch(function(err){
    done(err);
  });
};

/**
 * Remove a version of NPM
 * @param {string} v
 * @param {function} done
 * @return {*}
 */
NPMIST.remove = function(v, done){
  var version = semver.clean(v);
  if(!semver.valid(version)) return done(new Error('Invalid version'));
  var archivePath = path.resolve(path.join(this.repoPath,version));

  //check if this version is already not installed, if so just bail
  if(!fs.existsSync(archivePath)){
    return done(null,version);
  }

  //nuke everything for this version
  P.all([rimraf(archivePath)])
    .then(function(){
      done(null,version);
    })
    .catch(function(err){
      done(err);
    });
};


/**
 * Install NPM version
 * @param {string} v
 * @param {function} done
 * @return {*}
 */
NPMIST.install = function(v,done){
  debug('install', v)
  var version = semver.clean(v);
  if(!semver.valid(version)) return done(new Error('Invalid version'));

  var zipFile = path.resolve(path.join(this.repoPath,version + '.zip'));
  var archivePath = path.resolve(path.join(this.repoPath,version));

  //check if this version is already installed, if so just bail
  if(fs.existsSync(archivePath)){
    debug('install', 'this version is already installed')
    return done(null, version)
  }

  //otherwise install the new version
  Promise.resolve()
  .then(() => mkdirp(archivePath))
  .then(() => {
    var downloadLink = NPMIST.downloadUrl(version);
    debug('Downloading and extracting NPM from ' + downloadLink);

    return new Promise((resolve, reject) => {
      buildHelper.downloadFileStream(downloadLink)
      .pipe(zlib.createUnzip())
      .pipe(tar.x({
        cwd: archivePath
      , strip: 1
      }))
      .on('error', reject)
      .on('end', resolve)
    })
  })
  .then(() => {
    if (semver.gte(version, '8.0.0')) {
      debug('Fix symlinks for npm version >= 8');
      return resolveLinkedWorkspaces(path.join(archivePath, 'node_modules'))
        .then(fixedLinks => {
          debug(`Fixed ${fixedLinks} symlinks for npm node_modules`);
        });
    }
  })
  .then(() => {
    done(null, version)
  })
  .catch((err) => {
    done(err);
  });
};

/**
 * Sets the global npm version
 * @param {string} version
 * @param {function} cb accepting (err)
 */
NPMIST.setGlobal = function setGlobal(versionSpec, cb){
  var globalFile = this.nodist.nodistDir+'/.npm-version-global';
  fs.writeFile(globalFile, versionSpec, function(er) {
    if(er){
      return cb(new Error(
        'Could not set npm version ' + versionSpec + ' (' + er.message + ')'
      ));
    }
    cb();
  });
};


/**
 * Gets the global npm version
 * @param {function} cb a callback accepting (err)
 */
NPMIST.getGlobal = function getGlobal(cb){
  var globalFile = this.nodist.nodistDir+'/.npm-version-global';
  fs.readFile(globalFile, function(er, version){
    if(er) return cb(er);
    cb(null, version.toString().trim(), cb);
  });
};


/**
 * Sets the local npm version
 * @param {string} version
 * @param {function} cb function accepting (err)
 */
NPMIST.setLocal = function setLocal(versionSpec, cb) {
  fs.writeFile('./.npm-version', versionSpec, function(er){
    if(er){
      return cb(new Error(
        'Could not set npm version ' + versionSpec + ' (' + er.message + ')'
      ));
    }
    cb(null, process.cwd() + '\\.npm-version');
  });
};


/**
 * Gets the local npm version
 * @param {function} cb callback accepting (err, version)
 */
NPMIST.getLocal = function getLocal(cb){
  var dir = process.cwd();
  var dirArray = dir.split('\\');

  //NOTE: this function is recursive and could loop!!
  function search(){
    if(dirArray.length === 0) return cb();
    dir = dirArray.join('\\');
    var file = dir + '\\.npm-version';
    fs.readFile(file, function(er, version){
      if(er){
        dirArray.pop();
        return search();
      }
      cb(null, version.toString().trim(), file);
    });
  }
  search();
};


/**
 * Gets the environmental npm version
 * @param {function} cb a callback accepting (err, env)
 * @return {*} nothing
 */
NPMIST.getEnv = function getEnv(cb) {
  if(!this.envVersion) return cb();
  cb(null, this.envVersion);
};
