/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
// jshint node:true
'use strict';
var hydrolysis = require('hydrolysis');
var mkdirp = require('mkdirp');
var url = require('url');
var Vulcan = require('vulcanize');
var fs = require('fs');
var Promise = require('es6-promise').Promise;
var path = require('path');

var WebComponentShards = function WebComponentShards(options){
  this.root = path.resolve(options.root);
  this.endpoints = options.endpoints;
  this.bowerdir = options.bowerdir;
  this.shared_import = options.shared_import;
  this.sharing_threshold = options.sharing_threshold;
  this.dest_dir = path.resolve(options.dest_dir) + "/";
  this.workdir = options.workdir;
  this.depReport = options.depReport;
  this.stripExcludes = options.stripExcludes;
  this.built = false;
};


WebComponentShards.prototype = {
  _getOptions: function() {
    var options = {};
    options.attachAST = true;
    options.filter = function(){
      return false;
    };
    options.redirect = this.bowerdir;
    options.root = this.root;
    return options;
  },
  _getFSResolver: function() {
    return new hydrolysis.FSResolver(this._getOptions());
  },
  _getAnalyzer: function(endpoint) {
    return hydrolysis.Analyzer.analyze(endpoint, this._getOptions());
  },
  _getDeps: function _getDeps(endpoint) {
    return this._getAnalyzer(endpoint).then(function(analyzer){
      return analyzer._getDependencies(endpoint);
    }).catch(function(err){
      console.log(err);
      console.log("FAILED IN GETDEPS");
    });
  },
  _getCommonDeps: function _getCommonDeps(excludes) {
    var endpointDeps = [];
    for (var i = 0; i < this.endpoints.length; i++) {
      endpointDeps.push((function(endpoint) {
        return this._getDeps(endpoint).then(function(deps) {
          return {
            endpoint: endpoint,
            deps: deps
          };
        });
      }.bind(this))(this.endpoints[i]));
    }
    return Promise.all(endpointDeps).then(function(allEndpointDeps){
      var common = {};
      allEndpointDeps.forEach(function(endpointDep){
        endpointDep.deps.forEach(function(dep){
          if (!common[dep]) {
            common[dep] = 1;
          } else {
            common[dep] += 1;
          }
        });
      });
      var depsOverThreshold = [];
      for (var dep in common) {
        if (common[dep] >= this.sharing_threshold && (excludes.indexOf(dep) < 0)) {
          depsOverThreshold.push(dep);
        }
      }
      if (this.depReport) {
        var report = allEndpointDeps.reduce(function(prev, value) {
          prev[value.endpoint] = value.deps.filter(function(dep) {
            return (common[dep] < this.sharing_threshold) && (excludes.indexOf(dep) < 0);
          }.bind(this));
          return prev;
        }.bind(this), {});
        report[this.shared_import] = depsOverThreshold;

        var outputPath = path.resolve(process.cwd(), this.depReport);
        var outDir = path.dirname(outputPath);
        mkdirp.sync(outDir);
        var fd = fs.openSync(outputPath, 'w');
        fs.writeSync(fd, JSON.stringify(report));
      }
      return depsOverThreshold;
    }.bind(this));
  },
  _synthesizeImport: function _synthesizeImport(excludes) {
    return this._getCommonDeps(excludes).then(function(commonDeps) {
      /** Generate the file of shared imports. */
      var output = '';
      var outputPath = path.resolve(this.workdir, this.shared_import);
      /**
       * If the shared import is in a subdirectory, it needs to have a properly adjusted
       * base directory.
       */
      var baseUrl = path.relative(path.dirname(outputPath), this.workdir);
      if (baseUrl) {
        baseUrl += '/';
      }
      for (var dep in commonDeps) {
        output += '<link rel="import" href="' + baseUrl + commonDeps[dep] + '">\n';
      }
      var outDir = path.dirname(outputPath);
      mkdirp.sync(outDir);
      var fd = fs.openSync(outputPath, 'w');
      fs.writeSync(fd, output);
      return commonDeps;
    }.bind(this));
  },
  _flattenExcludes: function _flattenExcludes() {
    var exDeps = [];
    for (var i = 0; i < this.stripExcludes.length; i++) {
      exDeps.push((function(ex) {
        return this._getDeps(ex).then(function(deps) {
          return {
            endpoint: ex,
            deps: deps
          };
        });
      }.bind(this))(this.stripExcludes[i]));
    }
    return Promise.all(exDeps).then(function(allExDeps){
      var common = {};
      allExDeps.forEach(function(exDep){
        if (!common[exDep.endpoint]) {
          common[exDep.endpoint] = 1;
        } else {
          common[exDep.endpoint] += 1;
        }
        exDep.deps.forEach(function(dep){
          if (!common[dep]) {
            common[dep] = 1;
          } else {
            common[dep] += 1;
          }
        });
      });
      var deps = [];
      for (var dep in common) {
        deps.push(dep);
      }
      return deps;
    }.bind(this));
  },
  _prepOutput: function _prepOutput() {
    mkdirp.sync(this.dest_dir);
  },
  build: function build() {
    var excludes;
    if (this.built) {
      throw new Error("build may only be called once.");
    }
    this.built = true;
    this._prepOutput();
    return this._flattenExcludes().then(function(_excludes) {
      excludes = _excludes;
      return this._synthesizeImport(excludes);
    }.bind(this)).then(function(commonDeps) {
      var endpointsVulcanized = [];
      var stripExcludes = excludes.concat(commonDeps);
      // Vulcanize each endpoint
      this.endpoints.forEach(function(endpoint){
        var outPath = url.resolve(this.dest_dir, endpoint);
        var outDir = path.dirname(outPath);
        var pathToShared = path.relative(outDir, url.resolve(this.dest_dir, this.shared_import));
        var oneEndpointDone = new Promise(function(resolve, reject) {
          var vulcan = new Vulcan({
            abspath: null,
            fsResolver: this._getFSResolver(),
            addedImports: [pathToShared],
            stripExcludes: stripExcludes,
            inlineScripts: true,
            inlineCss: true,
            inputUrl: endpoint
          });
          try {
            vulcan.process(null, function(err, doc) {
              if (err) {
                reject(err);
              } else {
                mkdirp.sync(outDir);
                var fd = fs.openSync(outPath, 'w');
                fs.writeSync(fd, doc);
                resolve(outPath);
              }
            }.bind(this));
          } catch (err) {
            console.error("Error writing output file!");
            reject(err);
          }
        }.bind(this));
        endpointsVulcanized.push(oneEndpointDone);
      }.bind(this));
      var sharedEndpointDone = new Promise(function(resolve, reject) {
        // Create a resolver that knows about shared.html being in another place.
        var fsResolver = this._getFSResolver();
        var accept = function(uri, deferred) {
          if (uri === this.shared_import) {
            var sharedImportPath = path.resolve(this.workdir, this.shared_import);
            fs.readFile(sharedImportPath, 'utf-8', function(err, content) {
              if (err) {
                console.log("ERROR finding " + sharedImportPath);
                deferred.reject(err);
              } else {
                deferred.resolve(content);
              }
            });
            return true;
          } else {
            return fsResolver.accept(uri, deferred);
          }
        }.bind(this);
        var vulcan = new Vulcan({
          fsResolver: { accept: accept },
          inlineScripts: true,
          inlineCss: true,
          inputUrl: this.shared_import,
          stripExcludes: excludes
        });
        try {
          vulcan.process(null, function(err, doc) {
            if (err) {
              reject(err);
            } else {
              var outPath = url.resolve(this.dest_dir, this.shared_import);
              var outDir = path.dirname(outPath);
              mkdirp.sync(outDir);
              var fd = fs.openSync(outPath, 'w');
              fs.writeSync(fd, doc);
              resolve(outPath);
            }
          }.bind(this));
        } catch (err) {
          reject(err);
        }
      }.bind(this));
      endpointsVulcanized.push(sharedEndpointDone);
      return Promise.all(endpointsVulcanized);
      // Vulcanize the shared dep.
    }.bind(this));
  }
};

module.exports = WebComponentShards;
