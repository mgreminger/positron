"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.copyExtensionBinaries = exports.buildExtensionMedia = exports.webpackExtensions = exports.translatePackageJSON = exports.scanBuiltinExtensions = exports.packageMarketplaceExtensionsStream = exports.packageLocalExtensionsStream = exports.fromGithub = exports.fromMarketplace = void 0;
const es = require("event-stream");
const fs = require("fs");
const cp = require("child_process");
const glob = require("glob");
const gulp = require("gulp");
const path = require("path");
const through2 = require("through2");
const got_1 = require("got");
const File = require("vinyl");
const stats_1 = require("./stats");
const util2 = require("./util");
const vzip = require('gulp-vinyl-zip');
const filter = require("gulp-filter");
const rename = require("gulp-rename");
const fancyLog = require("fancy-log");
const ansiColors = require("ansi-colors");
const buffer = require('gulp-buffer');
const jsoncParser = require("jsonc-parser");
const dependencies_1 = require("./dependencies");
const _ = require("underscore");
const builtInExtensions_1 = require("./builtInExtensions");
const getVersion_1 = require("./getVersion");
const root = path.dirname(path.dirname(__dirname));
const commit = (0, getVersion_1.getVersion)(root);
const sourceMappingURLBase = `https://ticino.blob.core.windows.net/sourcemaps/${commit}`;
function minifyExtensionResources(input) {
    const jsonFilter = filter(['**/*.json', '**/*.code-snippets'], { restore: true });
    return input
        .pipe(jsonFilter)
        .pipe(buffer())
        .pipe(es.mapSync((f) => {
        const errors = [];
        const value = jsoncParser.parse(f.contents.toString('utf8'), errors, { allowTrailingComma: true });
        if (errors.length === 0) {
            // file parsed OK => just stringify to drop whitespace and comments
            f.contents = Buffer.from(JSON.stringify(value));
        }
        return f;
    }))
        .pipe(jsonFilter.restore);
}
function updateExtensionPackageJSON(input, update) {
    const packageJsonFilter = filter('extensions/*/package.json', { restore: true });
    return input
        .pipe(packageJsonFilter)
        .pipe(buffer())
        .pipe(es.mapSync((f) => {
        const data = JSON.parse(f.contents.toString('utf8'));
        f.contents = Buffer.from(JSON.stringify(update(data)));
        return f;
    }))
        .pipe(packageJsonFilter.restore);
}
function fromLocal(extensionPath, forWeb) {
    const webpackConfigFileName = forWeb ? 'extension-browser.webpack.config.js' : 'extension.webpack.config.js';
    const isWebPacked = fs.existsSync(path.join(extensionPath, webpackConfigFileName));
    let input = isWebPacked
        ? fromLocalWebpack(extensionPath, webpackConfigFileName)
        : fromLocalNormal(extensionPath);
    if (isWebPacked) {
        input = updateExtensionPackageJSON(input, (data) => {
            delete data.scripts;
            delete data.dependencies;
            delete data.devDependencies;
            if (data.main) {
                data.main = data.main.replace('/out/', /dist/);
            }
            return data;
        });
    }
    return input;
}
function fromLocalWebpack(extensionPath, webpackConfigFileName) {
    const result = es.through();
    const packagedDependencies = [];
    const packageJsonConfig = require(path.join(extensionPath, 'package.json'));
    if (packageJsonConfig.dependencies) {
        const webpackRootConfig = require(path.join(extensionPath, webpackConfigFileName));
        for (const key in webpackRootConfig.externals) {
            if (key in packageJsonConfig.dependencies) {
                packagedDependencies.push(key);
            }
        }
    }
    const vsce = require('vsce');
    const webpack = require('webpack');
    const webpackGulp = require('webpack-stream');
    vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.Yarn, packagedDependencies }).then(fileNames => {
        const files = fileNames
            .map(fileName => path.join(extensionPath, fileName))
            .map(filePath => new File({
            path: filePath,
            stat: fs.statSync(filePath),
            base: extensionPath,
            contents: fs.createReadStream(filePath)
        }));
        // check for a webpack configuration files, then invoke webpack
        // and merge its output with the files stream.
        const webpackConfigLocations = glob.sync(path.join(extensionPath, '**', webpackConfigFileName), { ignore: ['**/node_modules'] });
        const webpackStreams = webpackConfigLocations.map(webpackConfigPath => {
            const webpackDone = (err, stats) => {
                fancyLog(`Bundled extension: ${ansiColors.yellow(path.join(path.basename(extensionPath), path.relative(extensionPath, webpackConfigPath)))}...`);
                if (err) {
                    result.emit('error', err);
                }
                const { compilation } = stats;
                if (compilation.errors.length > 0) {
                    result.emit('error', compilation.errors.join('\n'));
                }
                if (compilation.warnings.length > 0) {
                    result.emit('error', compilation.warnings.join('\n'));
                }
            };
            const webpackConfig = {
                ...require(webpackConfigPath),
                ...{ mode: 'production' }
            };
            const relativeOutputPath = path.relative(extensionPath, webpackConfig.output.path);
            return webpackGulp(webpackConfig, webpack, webpackDone)
                .pipe(es.through(function (data) {
                data.stat = data.stat || {};
                data.base = extensionPath;
                this.emit('data', data);
            }))
                .pipe(es.through(function (data) {
                // source map handling:
                // * rewrite sourceMappingURL
                // * save to disk so that upload-task picks this up
                const contents = data.contents.toString('utf8');
                data.contents = Buffer.from(contents.replace(/\n\/\/# sourceMappingURL=(.*)$/gm, function (_m, g1) {
                    return `\n//# sourceMappingURL=${sourceMappingURLBase}/extensions/${path.basename(extensionPath)}/${relativeOutputPath}/${g1}`;
                }), 'utf8');
                this.emit('data', data);
            }));
        });
        es.merge(...webpackStreams, es.readArray(files))
            // .pipe(es.through(function (data) {
            // 	// debug
            // 	console.log('out', data.path, data.contents.length);
            // 	this.emit('data', data);
            // }))
            .pipe(result);
    }).catch(err => {
        console.error(extensionPath);
        console.error(packagedDependencies);
        result.emit('error', err);
    });
    return result.pipe((0, stats_1.createStatsStream)(path.basename(extensionPath)));
}
function fromLocalNormal(extensionPath) {
    const result = es.through();
    const vsce = require('vsce');
    vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.Yarn })
        .then(fileNames => {
        const files = fileNames
            .map(fileName => path.join(extensionPath, fileName))
            .map(filePath => new File({
            path: filePath,
            stat: fs.statSync(filePath),
            base: extensionPath,
            contents: fs.createReadStream(filePath)
        }));
        es.readArray(files).pipe(result);
    })
        .catch(err => result.emit('error', err));
    return result.pipe((0, stats_1.createStatsStream)(path.basename(extensionPath)));
}
const userAgent = 'VSCode Build';
const baseHeaders = {
    'X-Market-Client-Id': 'VSCode Build',
    'User-Agent': userAgent,
    'X-Market-User-Id': '291C1CD0-051A-4123-9B4B-30D60EF52EE2',
};
function fromMarketplace(serviceUrl, { name: extensionName, version, metadata }) {
    const remote = require('gulp-remote-retry-src');
    const json = require('gulp-json-editor');
    const [publisher, name] = extensionName.split('.');
    const url = `${serviceUrl}/publishers/${publisher}/vsextensions/${name}/${version}/vspackage`;
    fancyLog('Downloading extension:', ansiColors.yellow(`${extensionName}@${version}`), '...');
    const options = {
        base: url,
        requestOptions: {
            gzip: true,
            headers: baseHeaders
        }
    };
    const packageJsonFilter = filter('package.json', { restore: true });
    return remote('', options)
        .pipe(vzip.src())
        .pipe(filter('extension/**'))
        .pipe(rename(p => p.dirname = p.dirname.replace(/^extension\/?/, '')))
        .pipe(packageJsonFilter)
        .pipe(buffer())
        .pipe(json({ __metadata: metadata }))
        .pipe(packageJsonFilter.restore);
}
exports.fromMarketplace = fromMarketplace;
const ghApiHeaders = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': userAgent,
};
if (process.env.GITHUB_TOKEN) {
    ghApiHeaders.Authorization = 'Basic ' + Buffer.from(process.env.GITHUB_TOKEN).toString('base64');
}
const ghDownloadHeaders = {
    ...ghApiHeaders,
    Accept: 'application/octet-stream',
};
function fromGithub({ name, version, repo, metadata }) {
    const remote = require('gulp-remote-retry-src');
    const json = require('gulp-json-editor');
    fancyLog('Downloading extension from GH:', ansiColors.yellow(`${name}@${version}`), '...');
    const packageJsonFilter = filter('package.json', { restore: true });
    return remote([`/repos${new URL(repo).pathname}/releases/tags/v${version}`], {
        base: 'https://api.github.com',
        requestOptions: { headers: ghApiHeaders }
    }).pipe(through2.obj(function (file, _enc, callback) {
        const asset = JSON.parse(file.contents.toString()).assets.find((a) => a.name.endsWith('.vsix'));
        if (!asset) {
            return callback(new Error(`Could not find vsix in release of ${repo} @ ${version}`));
        }
        const res = got_1.default.stream(asset.url, { headers: ghDownloadHeaders, followRedirect: true });
        file.contents = res.pipe(through2());
        callback(null, file);
    }))
        .pipe(buffer())
        .pipe(vzip.src())
        .pipe(filter('extension/**'))
        .pipe(rename(p => p.dirname = p.dirname.replace(/^extension\/?/, '')))
        .pipe(packageJsonFilter)
        .pipe(buffer())
        .pipe(json({ __metadata: metadata }))
        .pipe(packageJsonFilter.restore);
}
exports.fromGithub = fromGithub;
const excludedExtensions = [
    'vscode-api-tests',
    'vscode-colorize-tests',
    'vscode-test-resolver',
    'ms-vscode.node-debug',
    'ms-vscode.node-debug2',
];
const marketplaceWebExtensionsExclude = new Set([
    'ms-vscode.node-debug',
    'ms-vscode.node-debug2',
    'ms-vscode.js-debug-companion',
    'ms-vscode.js-debug',
    'ms-vscode.vscode-js-profile-table'
]);
const productJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../product.json'), 'utf8'));
const builtInExtensions = productJson.builtInExtensions || [];
const webBuiltInExtensions = productJson.webBuiltInExtensions || [];
/**
 * Loosely based on `getExtensionKind` from `src/vs/workbench/services/extensions/common/extensionManifestPropertiesService.ts`
 */
function isWebExtension(manifest) {
    if (Boolean(manifest.browser)) {
        return true;
    }
    if (Boolean(manifest.main)) {
        return false;
    }
    // neither browser nor main
    if (typeof manifest.extensionKind !== 'undefined') {
        const extensionKind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
        if (extensionKind.indexOf('web') >= 0) {
            return true;
        }
    }
    if (typeof manifest.contributes !== 'undefined') {
        for (const id of ['debuggers', 'terminal', 'typescriptServerPlugins']) {
            if (manifest.contributes.hasOwnProperty(id)) {
                return false;
            }
        }
    }
    return true;
}
function packageLocalExtensionsStream(forWeb) {
    const localExtensionsDescriptions = (glob.sync('extensions/*/package.json')
        .map(manifestPath => {
        const absoluteManifestPath = path.join(root, manifestPath);
        const extensionPath = path.dirname(path.join(root, manifestPath));
        const extensionName = path.basename(extensionPath);
        return { name: extensionName, path: extensionPath, manifestPath: absoluteManifestPath };
    })
        .filter(({ name }) => excludedExtensions.indexOf(name) === -1)
        .filter(({ name }) => builtInExtensions.every(b => b.name !== name))
        .filter(({ manifestPath }) => (forWeb ? isWebExtension(require(manifestPath)) : true)));
    const localExtensionsStream = minifyExtensionResources(es.merge(...localExtensionsDescriptions.map(extension => {
        return fromLocal(extension.path, forWeb)
            .pipe(rename(p => p.dirname = `extensions/${extension.name}/${p.dirname}`));
    })));
    let result;
    if (forWeb) {
        result = localExtensionsStream;
    }
    else {
        // also include shared production node modules
        const productionDependencies = (0, dependencies_1.getProductionDependencies)('extensions/');
        const dependenciesSrc = _.flatten(productionDependencies.map(d => path.relative(root, d.path)).map(d => [`${d}/**`, `!${d}/**/{test,tests}/**`]));
        result = es.merge(localExtensionsStream, gulp.src(dependenciesSrc, { base: '.' }));
    }
    return (result
        .pipe(util2.setExecutableBit(['**/*.sh'])));
}
exports.packageLocalExtensionsStream = packageLocalExtensionsStream;
function packageMarketplaceExtensionsStream(forWeb) {
    const marketplaceExtensionsDescriptions = [
        ...builtInExtensions.filter(({ name }) => (forWeb ? !marketplaceWebExtensionsExclude.has(name) : true)),
        ...(forWeb ? webBuiltInExtensions : [])
    ];
    const marketplaceExtensionsStream = minifyExtensionResources(es.merge(...marketplaceExtensionsDescriptions
        .map(extension => {
        const src = (0, builtInExtensions_1.getExtensionStream)(extension).pipe(rename(p => p.dirname = `extensions/${p.dirname}`));
        return updateExtensionPackageJSON(src, (data) => {
            delete data.scripts;
            delete data.dependencies;
            delete data.devDependencies;
            return data;
        });
    })));
    return (marketplaceExtensionsStream
        .pipe(util2.setExecutableBit(['**/*.sh'])));
}
exports.packageMarketplaceExtensionsStream = packageMarketplaceExtensionsStream;
function scanBuiltinExtensions(extensionsRoot, exclude = []) {
    const scannedExtensions = [];
    try {
        const extensionsFolders = fs.readdirSync(extensionsRoot);
        for (const extensionFolder of extensionsFolders) {
            if (exclude.indexOf(extensionFolder) >= 0) {
                continue;
            }
            const packageJSONPath = path.join(extensionsRoot, extensionFolder, 'package.json');
            if (!fs.existsSync(packageJSONPath)) {
                continue;
            }
            const packageJSON = JSON.parse(fs.readFileSync(packageJSONPath).toString('utf8'));
            if (!isWebExtension(packageJSON)) {
                continue;
            }
            const children = fs.readdirSync(path.join(extensionsRoot, extensionFolder));
            const packageNLSPath = children.filter(child => child === 'package.nls.json')[0];
            const packageNLS = packageNLSPath ? JSON.parse(fs.readFileSync(path.join(extensionsRoot, extensionFolder, packageNLSPath)).toString()) : undefined;
            let browserNlsMetadataPath;
            if (packageJSON.browser) {
                const browserEntrypointFolderPath = path.join(extensionFolder, path.dirname(packageJSON.browser));
                if (fs.existsSync(path.join(extensionsRoot, browserEntrypointFolderPath, 'nls.metadata.json'))) {
                    browserNlsMetadataPath = path.join(browserEntrypointFolderPath, 'nls.metadata.json');
                }
            }
            const readme = children.filter(child => /^readme(\.txt|\.md|)$/i.test(child))[0];
            const changelog = children.filter(child => /^changelog(\.txt|\.md|)$/i.test(child))[0];
            scannedExtensions.push({
                extensionPath: extensionFolder,
                packageJSON,
                packageNLS,
                browserNlsMetadataPath,
                readmePath: readme ? path.join(extensionFolder, readme) : undefined,
                changelogPath: changelog ? path.join(extensionFolder, changelog) : undefined,
            });
        }
        return scannedExtensions;
    }
    catch (ex) {
        return scannedExtensions;
    }
}
exports.scanBuiltinExtensions = scanBuiltinExtensions;
function translatePackageJSON(packageJSON, packageNLSPath) {
    const CharCode_PC = '%'.charCodeAt(0);
    const packageNls = JSON.parse(fs.readFileSync(packageNLSPath).toString());
    const translate = (obj) => {
        for (const key in obj) {
            const val = obj[key];
            if (Array.isArray(val)) {
                val.forEach(translate);
            }
            else if (val && typeof val === 'object') {
                translate(val);
            }
            else if (typeof val === 'string' && val.charCodeAt(0) === CharCode_PC && val.charCodeAt(val.length - 1) === CharCode_PC) {
                const translated = packageNls[val.substr(1, val.length - 2)];
                if (translated) {
                    obj[key] = typeof translated === 'string' ? translated : (typeof translated.message === 'string' ? translated.message : val);
                }
            }
        }
    };
    translate(packageJSON);
    return packageJSON;
}
exports.translatePackageJSON = translatePackageJSON;
const extensionsPath = path.join(root, 'extensions');
// Additional projects to run esbuild on. These typically build code for webviews
const esbuildMediaScripts = [
    'markdown-language-features/esbuild-notebook.js',
    'markdown-language-features/esbuild-preview.js',
    'markdown-math/esbuild.js',
    'notebook-renderers/esbuild.js',
    'ipynb/esbuild.js',
    'simple-browser/esbuild-preview.js',
];
async function webpackExtensions(taskName, isWatch, webpackConfigLocations) {
    const webpack = require('webpack');
    const webpackConfigs = [];
    for (const { configPath, outputRoot } of webpackConfigLocations) {
        const configOrFnOrArray = require(configPath);
        function addConfig(configOrFn) {
            let config;
            if (typeof configOrFn === 'function') {
                config = configOrFn({}, {});
                webpackConfigs.push(config);
            }
            else {
                config = configOrFn;
            }
            if (outputRoot) {
                config.output.path = path.join(outputRoot, path.relative(path.dirname(configPath), config.output.path));
            }
            webpackConfigs.push(configOrFn);
        }
        addConfig(configOrFnOrArray);
    }
    function reporter(fullStats) {
        if (Array.isArray(fullStats.children)) {
            for (const stats of fullStats.children) {
                const outputPath = stats.outputPath;
                if (outputPath) {
                    const relativePath = path.relative(extensionsPath, outputPath).replace(/\\/g, '/');
                    const match = relativePath.match(/[^\/]+(\/server|\/client)?/);
                    fancyLog(`Finished ${ansiColors.green(taskName)} ${ansiColors.cyan(match[0])} with ${stats.errors.length} errors.`);
                }
                if (Array.isArray(stats.errors)) {
                    stats.errors.forEach((error) => {
                        fancyLog.error(error);
                    });
                }
                if (Array.isArray(stats.warnings)) {
                    stats.warnings.forEach((warning) => {
                        fancyLog.warn(warning);
                    });
                }
            }
        }
    }
    return new Promise((resolve, reject) => {
        if (isWatch) {
            webpack(webpackConfigs).watch({}, (err, stats) => {
                if (err) {
                    reject();
                }
                else {
                    reporter(stats?.toJson());
                }
            });
        }
        else {
            webpack(webpackConfigs).run((err, stats) => {
                if (err) {
                    fancyLog.error(err);
                    reject();
                }
                else {
                    reporter(stats?.toJson());
                    resolve();
                }
            });
        }
    });
}
exports.webpackExtensions = webpackExtensions;
async function esbuildExtensions(taskName, isWatch, scripts) {
    function reporter(stdError, script) {
        const matches = (stdError || '').match(/\> (.+): error: (.+)?/g);
        fancyLog(`Finished ${ansiColors.green(taskName)} ${script} with ${matches ? matches.length : 0} errors.`);
        for (const match of matches || []) {
            fancyLog.error(match);
        }
    }
    const tasks = scripts.map(({ script, outputRoot }) => {
        return new Promise((resolve, reject) => {
            const args = [script];
            if (isWatch) {
                args.push('--watch');
            }
            if (outputRoot) {
                args.push('--outputRoot', outputRoot);
            }
            const proc = cp.execFile(process.argv[0], args, {}, (error, _stdout, stderr) => {
                if (error) {
                    return reject(error);
                }
                reporter(stderr, script);
                if (stderr) {
                    return reject();
                }
                return resolve();
            });
            proc.stdout.on('data', (data) => {
                fancyLog(`${ansiColors.green(taskName)}: ${data.toString('utf8')}`);
            });
        });
    });
    return Promise.all(tasks);
}
async function buildExtensionMedia(isWatch, outputRoot) {
    return esbuildExtensions('esbuilding extension media', isWatch, esbuildMediaScripts.map(p => ({
        script: path.join(extensionsPath, p),
        outputRoot: outputRoot ? path.join(root, outputRoot, path.dirname(p)) : undefined
    })));
}
exports.buildExtensionMedia = buildExtensionMedia;
// --- Start Positron ---
// This Gulp task is used to copy binaries verbatim from built-in extensions to
// the output folder. VS Code's built-in extensions are webpacked, and weback
// doesn't support copying binaries in any useful way (even with
// CopyWebpackPlugin, binaries are UTF corrupted and lose executable
// permissions), so we need to do it in a separate task.
async function copyExtensionBinaries(outputRoot) {
    return new Promise((resolve, _reject) => {
        // Collect all the Positron extension metadata for binaries that need to
        // be copied.  The Positron extension metadata lives in the
        // `positron.json` file in the extension's root directory.
        const binaryMetadata = _.flatten(glob.sync('extensions/*/positron.json')
            .map(metadataPath => {
            // Read the metadata file.
            const metadata = JSON.parse(fs.readFileSync(metadataPath).toString('utf8'));
            // Resolve the paths to the binaries.
            if (metadata.binaries) {
                return metadata.binaries.map((bin) => {
                    // Check the executable bit. Gulp can lose this on
                    // copy, so we may need to restore it later.
                    const stat = fs.statSync(path.join(path.dirname(metadataPath), bin.from));
                    return {
                        ...bin,
                        exe: (stat.mode & 0o100) !== 0,
                        base: path.basename(path.dirname(metadataPath)),
                    };
                });
            }
            return null;
        }));
        fancyLog(`Copying binaries for ${binaryMetadata.length} built-in Positron extensions`);
        // Create a stream of all the binaries.
        es.merge(
        // Map the metadata to a stream of Vinyl files from the source to the
        // destination.
        ...binaryMetadata.map((bin) => {
            return gulp.src(path.join('extensions', bin.base, bin.from)).pipe(gulp.dest(path.join(outputRoot, bin.base, bin.to)));
        }), 
        // Restore the executable bit on the binaries that had it.
        util2.setExecutableBit(binaryMetadata
            .filter((bin) => bin.exe)
            .map((bin) => path.join(outputRoot, bin.base, bin.to))));
        resolve();
    });
}
exports.copyExtensionBinaries = copyExtensionBinaries;
// --- End Positron ---
